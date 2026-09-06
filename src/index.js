const PERSON_COLOR_KEYS = [
  "blue", "purple", "rose", "orange", "emerald",
  "cyan", "amber", "lime", "red", "brown",
  "pink", "violet", "indigo", "green", "yellow",
  "sky", "mint", "coral", "slate", "gray"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/test-db") {
      const result = await env.DB
        .prepare("SELECT COUNT(*) AS bill_count FROM bills")
        .first();

      return Response.json({
        success: true,
        databaseConnected: true,
        billCount: result.bill_count
      });
    }

    if (url.pathname === "/api") {
      if (request.method !== "POST") {
        return json({
          ok: false,
          error: "POST requests only."
        });
      }

      try {
        const body = await request.json();
        const action = String(body.action || "");

        switch (action) {
          case "getAppState":
            return json({
              ok: true,
              state: await getAppState(env)
            });

          case "verifyAdmin":
            verifyAdminPin(env, body.adminPin);
            return json({ ok: true });

          case "saveBill":
          case "publishBill":
            verifyAdminPin(env, body.adminPin);

            return json({
              ok: true,
              state: await saveBill(env, body.bill || {})
            });

          case "saveSelection":
            return json({
              ok: true,
              state: await saveParticipantSelection(env, body)
            });

          case "updatePersonColor":
            return json({
              ok: true,
              state: await updatePersonColor(env, body)
            });

          default:
            return json({
              ok: false,
              error: "Unsupported action: " + action
            });
        }
      } catch (error) {
        console.error(error);

        // Keep HTTP 200 like your old Apps Script backend.
        // bill.html reads the error from data.error.
        return json({
          ok: false,
          error: error?.message || String(error)
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};


// ============================================================
// ADMIN
// ============================================================

function verifyAdminPin(env, candidate) {
  if (!env.ADMIN_PIN) {
    throw new Error("ADMIN_PIN secret is not configured.");
  }

  if (String(candidate || "") !== String(env.ADMIN_PIN)) {
    throw new Error("Incorrect admin PIN.");
  }
}


// ============================================================
// APP STATE
// ============================================================

async function getAppState(env) {
  const bill = await env.DB
    .prepare(`
      SELECT *
      FROM bills
      WHERE status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .first();

  if (!bill) {
    return {
      hasActiveBill: false
    };
  }

  return buildBillState(env, bill);
}


async function getBillById(env, billId) {
  return env.DB
    .prepare(`
      SELECT *
      FROM bills
      WHERE bill_id = ?
      LIMIT 1
    `)
    .bind(billId)
    .first();
}


async function buildBillState(env, bill) {
  const billId = String(bill.bill_id);

  const [
    peopleResult,
    itemsResult,
    selectionsResult
  ] = await Promise.all([
    env.DB
      .prepare(`
        SELECT *
        FROM people
        WHERE bill_id = ?
        ORDER BY sort_order, created_at
      `)
      .bind(billId)
      .all(),

    env.DB
      .prepare(`
        SELECT *
        FROM items
        WHERE bill_id = ?
        ORDER BY sort_order, created_at
      `)
      .bind(billId)
      .all(),

    env.DB
      .prepare(`
        SELECT *
        FROM selections
        WHERE bill_id = ?
      `)
      .bind(billId)
      .all()
  ]);

  const people = (peopleResult.results || []).map(
    (row, index) => {
      const storedColor = String(row.color || "")
        .trim()
        .toLowerCase();

      return {
        personId: String(row.person_id),
        name: String(row.name || ""),
        color: PERSON_COLOR_KEYS.includes(storedColor)
          ? storedColor
          : PERSON_COLOR_KEYS[index % PERSON_COLOR_KEYS.length]
      };
    }
  );

  const items = (itemsResult.results || []).map(row => ({
    itemId: String(row.item_id),
    name: String(row.name || ""),
    quantity: numberOrNull(row.quantity),
    unitPrice: numberOrNull(row.unit_price),
    lineTotal: Number(row.line_total || 0)
  }));

  const selections = (selectionsResult.results || []).map(
    row => ({
      personId: String(row.person_id),
      itemId: String(row.item_id),
      shareAmount: Number(row.share_amount || 0)
    })
  );

  const assignedByItem = {};

  for (const selection of selections) {
    assignedByItem[selection.itemId] = roundMoney(
      (assignedByItem[selection.itemId] || 0) +
      selection.shareAmount
    );
  }

  return {
    hasActiveBill: bill.status === "active",

    bill: {
      billId,
      billName: String(bill.title || ""),
      storeName: String(bill.restaurant_name || ""),
      address: String(bill.address || ""),
      date: String(bill.receipt_date || ""),
      time: String(bill.receipt_time || ""),
      subtotal: Number(bill.subtotal || 0),
      tax: Number(bill.tax || 0),
      tip: Number(bill.tip || 0),
      grandTotal: Number(bill.grand_total || 0),

      status:
        bill.status === "active"
          ? "OPEN"
          : "ARCHIVED",

      createdAt: bill.created_at || "",
      updatedAt: bill.updated_at || ""
    },

    people,
    items,
    selections,
    assignedByItem
  };
}


// ============================================================
// SAVE / CREATE BILL
// ============================================================

async function saveBill(env, inputBill) {
  const bill = normalizeBillInput(inputBill);

  const activeBill = await env.DB
    .prepare(`
      SELECT *
      FROM bills
      WHERE status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .first();

  const requestedBillId =
    String(inputBill.billId || "").trim();

  if (requestedBillId) {
    if (
      !activeBill ||
      String(activeBill.bill_id) !== requestedBillId
    ) {
      throw new Error(
        "This bill is no longer the active bill. Reload the page before saving."
      );
    }

    await updateExistingBill(
      env,
      requestedBillId,
      bill
    );
  } else {
    if (activeBill) {
      throw new Error(
        "An active bill already exists. Edit or archive it before creating another bill."
      );
    }

    await createNewBill(env, bill);
  }

  return getAppState(env);
}


function normalizeBillInput(bill) {
  const rawPeople =
    Array.isArray(bill.people)
      ? bill.people
      : [];

  const people = [];

  rawPeople.forEach((person, index) => {
    const value =
      typeof person === "string"
        ? { name: person }
        : (person || {});

    const name =
      String(value.name || "").trim();

    if (!name) return;

    const duplicate = people.some(
      existing =>
        existing.name.toLowerCase() ===
        name.toLowerCase()
    );

    if (duplicate) {
      throw new Error(
        "Participant names must be unique."
      );
    }

    const requestedColor =
      String(value.color || "")
        .trim()
        .toLowerCase();

    people.push({
      personId:
        String(value.personId || "").trim(),

      name,

      sortOrder: index + 1,

      color:
        PERSON_COLOR_KEYS.includes(
          requestedColor
        )
          ? requestedColor
          : ""
    });
  });

  if (!people.length) {
    throw new Error(
      "Add at least one participant."
    );
  }

  // Assign unused colors automatically.
  const usedColors = {};

  people.forEach((person, index) => {
    if (
      !person.color ||
      usedColors[person.color]
    ) {
      person.color =
        firstAvailablePersonColor(
          usedColors,
          index
        );
    }

    usedColors[person.color] = true;
  });


  const rawItems =
    Array.isArray(bill.items)
      ? bill.items
      : [];

  if (!rawItems.length) {
    throw new Error(
      "The bill must have at least one line item."
    );
  }

  const items = rawItems.map(
    (item, index) => {
      const name =
        String(item.name || "").trim();

      const lineTotal =
        Number(item.lineTotal);

      if (
        !name ||
        !Number.isFinite(lineTotal) ||
        lineTotal < 0
      ) {
        throw new Error(
          "Every item needs a name and valid line total."
        );
      }

      const assignments =
        Array.isArray(item.assignments)
          ? item.assignments
              .map(assignment => ({
                personId:
                  String(
                    assignment.personId || ""
                  ).trim(),

                name:
                  String(
                    assignment.name || ""
                  ).trim(),

                shareAmount: roundMoney(
                  Number(
                    assignment.shareAmount || 0
                  )
                )
              }))
              .filter(
                assignment =>
                  assignment.shareAmount > 0
              )
          : [];

      return {
        itemId:
          String(item.itemId || "").trim(),

        name,

        quantity:
          numberOrNull(item.quantity),

        unitPrice:
          numberOrNull(item.unitPrice),

        lineTotal:
          roundMoney(lineTotal),

        sortOrder: index + 1,

        assignments,

        assignmentsTouched:
          Boolean(item.assignmentsTouched)
      };
    }
  );


  return {
    billName:
      String(bill.billName || "").trim() ||
      "Shared Bill",

    storeName:
      String(bill.storeName || "").trim(),

    address:
      String(bill.address || "").trim(),

    date:
      String(bill.date || "").trim(),

    time:
      String(bill.time || "").trim(),

    subtotal:
      requiredMoney(
        bill.subtotal,
        "subtotal"
      ),

    tax:
      requiredMoney(
        bill.tax,
        "tax"
      ),

    tip:
      requiredMoney(
        bill.tip,
        "tip"
      ),

    grandTotal:
      requiredMoney(
        bill.grandTotal,
        "grand total"
      ),

    people,
    items
  };
}


// ------------------------------------------------------------
// CREATE NEW BILL
// ------------------------------------------------------------

async function createNewBill(env, bill) {
  const billId = crypto.randomUUID();

  // Generate IDs before creating assignments.
  bill.people.forEach(person => {
    person.personId =
      crypto.randomUUID();
  });

  bill.items.forEach(item => {
    item.itemId =
      crypto.randomUUID();
  });

  const statements = [];

  statements.push(
    env.DB
      .prepare(`
        INSERT INTO bills (
          bill_id,
          title,
          restaurant_name,
          address,
          receipt_date,
          receipt_time,
          subtotal,
          tax,
          tip,
          grand_total,
          status,
          created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          'active',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `)
      .bind(
        billId,
        bill.billName,
        bill.storeName,
        bill.address,
        bill.date,
        bill.time,
        bill.subtotal,
        bill.tax,
        bill.tip,
        bill.grandTotal
      )
  );


  for (const person of bill.people) {
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO people (
            person_id,
            bill_id,
            name,
            color,
            sort_order,
            created_at
          )
          VALUES (
            ?, ?, ?, ?, ?,
            CURRENT_TIMESTAMP
          )
        `)
        .bind(
          person.personId,
          billId,
          person.name,
          person.color,
          person.sortOrder
        )
    );
  }


  for (const item of bill.items) {
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO items (
            item_id,
            bill_id,
            name,
            quantity,
            unit_price,
            line_total,
            sort_order,
            created_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            CURRENT_TIMESTAMP
          )
        `)
        .bind(
          item.itemId,
          billId,
          item.name,
          item.quantity,
          item.unitPrice,
          item.lineTotal,
          item.sortOrder
        )
    );
  }

  // First create the bill, people and items.
  await env.DB.batch(statements);

  await applyAdminAssignments(
    env,
    billId,
    bill.people,
    bill.items
  );
}


// ------------------------------------------------------------
// UPDATE EXISTING BILL
// ------------------------------------------------------------

async function updateExistingBill(
  env,
  billId,
  bill
) {
  const [
    existingPeopleResult,
    existingItemsResult,
    existingSelectionsResult
  ] = await Promise.all([
    env.DB
      .prepare(`
        SELECT *
        FROM people
        WHERE bill_id = ?
      `)
      .bind(billId)
      .all(),

    env.DB
      .prepare(`
        SELECT *
        FROM items
        WHERE bill_id = ?
      `)
      .bind(billId)
      .all(),

    env.DB
      .prepare(`
        SELECT *
        FROM selections
        WHERE bill_id = ?
      `)
      .bind(billId)
      .all()
  ]);

  const existingPeople =
    existingPeopleResult.results || [];

  const existingItems =
    existingItemsResult.results || [];

  const existingSelections =
    existingSelectionsResult.results || [];


  // Resolve participant IDs.
  for (const person of bill.people) {
    const idMatch =
      existingPeople.find(
        row =>
          String(row.person_id) ===
          person.personId
      );

    if (idMatch) continue;

    const nameMatch =
      existingPeople.find(
        row =>
          String(row.name || "")
            .toLowerCase() ===
          person.name.toLowerCase()
      );

    person.personId =
      nameMatch
        ? String(nameMatch.person_id)
        : crypto.randomUUID();
  }


  // Resolve item IDs.
  for (const item of bill.items) {
    const idMatch =
      existingItems.find(
        row =>
          String(row.item_id) ===
          item.itemId
      );

    if (!idMatch) {
      item.itemId =
        crypto.randomUUID();
    }

    const currentlyAssigned =
      item.assignmentsTouched
        ? item.assignments.reduce(
            (sum, assignment) =>
              sum +
              Number(
                assignment.shareAmount || 0
              ),
            0
          )
        : existingSelections
            .filter(
              row =>
                String(row.item_id) ===
                item.itemId
            )
            .reduce(
              (sum, row) =>
                sum +
                Number(
                  row.share_amount || 0
                ),
              0
            );

    if (
      currentlyAssigned >
      item.lineTotal + 0.01
    ) {
      throw new Error(
        item.name +
        " already has " +
        formatMoneyForError(
          currentlyAssigned
        ) +
        " claimed. Its line total cannot be reduced below that amount."
      );
    }
  }


  const statements = [];

  statements.push(
    env.DB
      .prepare(`
        UPDATE bills
        SET
          title = ?,
          restaurant_name = ?,
          address = ?,
          receipt_date = ?,
          receipt_time = ?,
          subtotal = ?,
          tax = ?,
          tip = ?,
          grand_total = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE bill_id = ?
      `)
      .bind(
        bill.billName,
        bill.storeName,
        bill.address,
        bill.date,
        bill.time,
        bill.subtotal,
        bill.tax,
        bill.tip,
        bill.grandTotal,
        billId
      )
  );


  // Upsert people.
  for (const person of bill.people) {
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO people (
            person_id,
            bill_id,
            name,
            color,
            sort_order,
            created_at
          )
          VALUES (
            ?, ?, ?, ?, ?,
            CURRENT_TIMESTAMP
          )

          ON CONFLICT(person_id)
          DO UPDATE SET
            name = excluded.name,
            color = excluded.color,
            sort_order = excluded.sort_order
        `)
        .bind(
          person.personId,
          billId,
          person.name,
          person.color,
          person.sortOrder
        )
    );
  }


  // Upsert items.
  for (const item of bill.items) {
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO items (
            item_id,
            bill_id,
            name,
            quantity,
            unit_price,
            line_total,
            sort_order,
            created_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            CURRENT_TIMESTAMP
          )

          ON CONFLICT(item_id)
          DO UPDATE SET
            name = excluded.name,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            line_total = excluded.line_total,
            sort_order = excluded.sort_order
        `)
        .bind(
          item.itemId,
          billId,
          item.name,
          item.quantity,
          item.unitPrice,
          item.lineTotal,
          item.sortOrder
        )
    );
  }

  await env.DB.batch(statements);


  // Remove people Admin explicitly deleted.
  const personIdsToKeep =
    bill.people.map(
      person => person.personId
    );

  await deleteRowsNotInList(
    env,
    "people",
    "person_id",
    billId,
    personIdsToKeep
  );


  // Remove items Admin explicitly deleted.
  const itemIdsToKeep =
    bill.items.map(
      item => item.itemId
    );

  await deleteRowsNotInList(
    env,
    "items",
    "item_id",
    billId,
    itemIdsToKeep
  );


  await applyAdminAssignments(
    env,
    billId,
    bill.people,
    bill.items
  );
}


// ============================================================
// ADMIN PRE-ASSIGNMENTS
// ============================================================

async function applyAdminAssignments(
  env,
  billId,
  people,
  items
) {
  const touchedItems =
    items.filter(
      item => item.assignmentsTouched
    );

  if (!touchedItems.length) {
    return;
  }

  const peopleById = {};
  const peopleByName = {};

  for (const person of people) {
    peopleById[person.personId] =
      person;

    peopleByName[
      person.name.toLowerCase()
    ] = person;
  }


  for (const item of touchedItems) {
    const assignments =
      item.assignments || [];

    const itemTotal =
      roundMoney(
        assignments.reduce(
          (sum, assignment) =>
            sum +
            Number(
              assignment.shareAmount || 0
            ),
          0
        )
      );

    if (
      itemTotal >
      item.lineTotal + 0.01
    ) {
      throw new Error(
        item.name +
        " has " +
        formatMoneyForError(itemTotal) +
        " assigned, which is more than its line total of " +
        formatMoneyForError(
          item.lineTotal
        ) +
        "."
      );
    }


    const statements = [
      env.DB
        .prepare(`
          DELETE FROM selections
          WHERE bill_id = ?
            AND item_id = ?
        `)
        .bind(
          billId,
          item.itemId
        )
    ];


    for (const assignment of assignments) {
      const person =
        peopleById[
          assignment.personId
        ] ||
        peopleByName[
          String(
            assignment.name || ""
          ).toLowerCase()
        ];

      if (!person) {
        throw new Error(
          "An assignment for " +
          item.name +
          " references a participant who no longer exists."
        );
      }


      statements.push(
        env.DB
          .prepare(`
            INSERT INTO selections (
              selection_id,
              bill_id,
              item_id,
              person_id,
              share_amount,
              created_at,
              updated_at
            )
            VALUES (
              ?, ?, ?, ?, ?,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
          `)
          .bind(
            crypto.randomUUID(),
            billId,
            item.itemId,
            person.personId,
            roundMoney(
              assignment.shareAmount
            )
          )
      );
    }

    await env.DB.batch(statements);
  }
}


// ============================================================
// PARTICIPANT SELECTIONS
// ============================================================

async function saveParticipantSelection(
  env,
  request
) {
  const state =
    await getAppState(env);

  if (!state.hasActiveBill) {
    throw new Error(
      "There is no active bill."
    );
  }

  const billId =
    state.bill.billId;

  const personId =
    String(
      request.personId || ""
    ).trim();

  const personExists =
    state.people.some(
      person =>
        person.personId ===
        personId
    );

  if (!personExists) {
    throw new Error(
      "The selected person was not found."
    );
  }

  const submitted =
    Array.isArray(
      request.selections
    )
      ? request.selections
      : [];

  const submittedMap = {};

  for (const selection of submitted) {
    const itemId =
      String(
        selection.itemId || ""
      );

    const amount =
      roundMoney(
        Number(
          selection.shareAmount || 0
        )
      );

    if (amount < 0) {
      throw new Error(
        "Item shares cannot be negative."
      );
    }

    submittedMap[itemId] =
      amount;
  }


  for (const item of state.items) {
    const otherPeopleAssigned =
      state.selections
        .filter(
          selection =>
            selection.itemId ===
              item.itemId &&
            selection.personId !==
              personId
        )
        .reduce(
          (sum, selection) =>
            sum +
            Number(
              selection.shareAmount || 0
            ),
          0
        );

    const requestedAmount =
      submittedMap[
        item.itemId
      ] || 0;

    if (
      otherPeopleAssigned +
        requestedAmount >
      Number(item.lineTotal) +
        0.01
    ) {
      const remaining =
        Math.max(
          0,
          Number(
            item.lineTotal
          ) -
          otherPeopleAssigned
        );

      throw new Error(
        item.name +
        " only has " +
        formatMoneyForError(
          remaining
        ) +
        " remaining."
      );
    }
  }


  const statements = [
    env.DB
      .prepare(`
        DELETE FROM selections
        WHERE bill_id = ?
          AND person_id = ?
      `)
      .bind(
        billId,
        personId
      )
  ];


  for (const item of state.items) {
    const amount =
      submittedMap[
        item.itemId
      ] || 0;

    if (amount <= 0) {
      continue;
    }

    statements.push(
      env.DB
        .prepare(`
          INSERT INTO selections (
            selection_id,
            bill_id,
            item_id,
            person_id,
            share_amount,
            created_at,
            updated_at
          )
          VALUES (
            ?, ?, ?, ?, ?,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
        `)
        .bind(
          crypto.randomUUID(),
          billId,
          item.itemId,
          personId,
          amount
        )
    );
  }


  await env.DB.batch(
    statements
  );

  return getAppState(env);
}


// ============================================================
// PERSON COLORS
// ============================================================

async function updatePersonColor(
  env,
  request
) {
  const state =
    await getAppState(env);

  if (!state.hasActiveBill) {
    throw new Error(
      "There is no active bill."
    );
  }

  const billId =
    state.bill.billId;

  const personId =
    String(
      request.personId || ""
    ).trim();

  const color =
    String(
      request.color || ""
    )
      .trim()
      .toLowerCase();


  if (
    !PERSON_COLOR_KEYS.includes(
      color
    )
  ) {
    throw new Error(
      "Choose one of the available colors."
    );
  }


  const person =
    state.people.find(
      candidate =>
        candidate.personId ===
        personId
    );

  if (!person) {
    throw new Error(
      "The selected person was not found."
    );
  }


  const claimedByOther =
    state.people.some(
      candidate =>
        candidate.personId !==
          personId &&
        candidate.color === color
    );

  if (claimedByOther) {
    throw new Error(
      "That color has already been claimed."
    );
  }


  const result =
    await env.DB
      .prepare(`
        UPDATE people
        SET color = ?
        WHERE bill_id = ?
          AND person_id = ?
      `)
      .bind(
        color,
        billId,
        personId
      )
      .run();


  if (!result.meta?.changes) {
    throw new Error(
      "The selected participant could not be updated."
    );
  }


  return getAppState(env);
}


// ============================================================
// DATABASE HELPERS
// ============================================================

async function deleteRowsNotInList(
  env,
  tableName,
  idColumn,
  billId,
  idsToKeep
) {
  if (!idsToKeep.length) {
    return;
  }

  const placeholders =
    idsToKeep
      .map(() => "?")
      .join(",");

  const sql = `
    DELETE FROM ${tableName}
    WHERE bill_id = ?
      AND ${idColumn}
        NOT IN (${placeholders})
  `;

  await env.DB
    .prepare(sql)
    .bind(
      billId,
      ...idsToKeep
    )
    .run();
}


// ============================================================
// HELPERS
// ============================================================

function firstAvailablePersonColor(
  usedColors,
  preferredIndex
) {
  for (
    let offset = 0;
    offset <
    PERSON_COLOR_KEYS.length;
    offset++
  ) {
    const key =
      PERSON_COLOR_KEYS[
        (
          Number(
            preferredIndex || 0
          ) +
          offset
        ) %
        PERSON_COLOR_KEYS.length
      ];

    if (!usedColors[key]) {
      return key;
    }
  }

  return PERSON_COLOR_KEYS[
    Number(
      preferredIndex || 0
    ) %
    PERSON_COLOR_KEYS.length
  ];
}


function requiredMoney(
  value,
  label
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    throw new Error(
      "Enter a valid " +
      label +
      "."
    );
  }

  return roundMoney(number);
}


function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function roundMoney(value) {
  return Math.round(
    (
      Number(value || 0) +
      Number.EPSILON
    ) * 100
  ) / 100;
}


function formatMoneyForError(
  value
) {
  return (
    "$" +
    Number(
      value || 0
    ).toFixed(2)
  );
}


function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}
