const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://chrisvillanpro.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const GEMINI_MODEL = "gemini-3.5-flash";

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

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS
        });
      }
    
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

          case "archiveActiveBill":
          case "clearActiveBill":
            verifyAdminPin(env, body.adminPin);

            await archiveActiveBill(env);

            return json({
              ok: true,
              state: await getAppState(env)
            });

          case "getBillHistory":
            verifyAdminPin(env, body.adminPin);

            return json({
              ok: true,
              bills: await getBillHistory(env)
            });

          case "getArchivedBill":
            verifyAdminPin(env, body.adminPin);

            return json({
              ok: true,
              state: await getBillStateById(
                env,
                String(body.billId || "")
              )
            });

          case "restoreBill":
            verifyAdminPin(env, body.adminPin);

            return json({
              ok: true,
              state: await restoreBill(
                env,
                String(body.billId || "")
              )
            });

          case "deleteArchivedBill":
            verifyAdminPin(env, body.adminPin);

            await deleteArchivedBill(
              env,
              String(body.billId || "")
            );

            return json({
              ok: true,
              bills: await getBillHistory(env)
            });

          case "analyzeReceiptImage":
            verifyAdminPin(env, body.adminPin);

            return json({
              ok: true,
              receipt: await analyzeReceiptImageWithGemini(
                env,
                String(body.mimeType || ""),
                String(body.imageBase64 || "")
              )
            });

          case "analyzeReceipt":
            verifyAdminPin(env, body.adminPin);

            return json({
              ok: true,
              receipt: await analyzeReceiptTextWithGemini(
                env,
                String(body.ocrText || "")
              )
            });
            
            // ============================================================
            // POLL
            // ============================================================
            
            case "pollLogin":
              return json({
                ok: true,
                ...(await pollLogin(env, body))
              });
            
            case "pollLoad":
              return json({
                ok: true,
                state: await loadPollState(env, body)
              });
            
            case "pollSave":
              return json({
                ok: true,
                state: await savePollAvailability(env, body)
              });
            case "pollAddPerson":
              return json({
                ok: true,
                state: await addPollPersonSelf(env, body)
              });
                        
            
            // ============================================================
            // POLL ADMIN
            // ============================================================
            
            case "pollAdminLoad":
              verifyPollAdmin(env, body.adminCode);
            
              return json({
                ok: true,
                state: await getPollAdminState(env)
              });
            
            
            case "pollAdminCreateSession":
              verifyPollAdmin(env, body.adminCode);
            
              return json({
                ok: true,
                state: await createPollSession(env, body)
              });
            
            
            case "pollAdminSaveSession":
              verifyPollAdmin(env, body.adminCode);
            
              return json({
                ok: true,
                state: await updatePollSession(env, body)
              });
            
            
            case "pollAdminDeleteSession":
              verifyPollAdmin(env, body.adminCode);
            
              return json({
                ok: true,
                state: await deletePollSession(env, body)
              });
            
            
            case "pollAdminAddPerson":
              verifyPollAdmin(env, body.adminCode);
            
              return json({
                ok: true,
                state: await addPollPerson(env, body)
              });
            
            
            case "pollAdminDeletePerson":
              verifyPollAdmin(env, body.adminCode);
            
              return json({
                ok: true,
                state: await deletePollPerson(env, body)
              });
            
          default:
            return json({
              ok: false,
              error: "Unsupported action: " + action
            });
        }
      } catch (error) {
        console.error(error);

        // Keep HTTP 200 like the old Apps Script backend.
        // bill.html reads errors from data.error.
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
    throw new Error(
      "ADMIN_PIN secret is not configured."
    );
  }

  if (
    String(candidate || "") !==
    String(env.ADMIN_PIN)
  ) {
    throw new Error(
      "Incorrect admin PIN."
    );
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
  const billId =
    String(bill.bill_id);

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

  const people =
    (peopleResult.results || []).map(
      (row, index) => {
        const storedColor =
          String(row.color || "")
            .trim()
            .toLowerCase();

        return {
          personId:
            String(row.person_id),

          name:
            String(row.name || ""),

          color:
            PERSON_COLOR_KEYS.includes(
              storedColor
            )
              ? storedColor
              : PERSON_COLOR_KEYS[
                  index %
                  PERSON_COLOR_KEYS.length
                ]
        };
      }
    );

  const items =
    (itemsResult.results || []).map(
      row => ({
        itemId:
          String(row.item_id),

        name:
          String(row.name || ""),

        quantity:
          numberOrNull(
            row.quantity
          ),

        unitPrice:
          numberOrNull(
            row.unit_price
          ),

        lineTotal:
          Number(
            row.line_total || 0
          )
      })
    );

  const selections =
    (selectionsResult.results || []).map(
      row => ({
        personId:
          String(row.person_id),

        itemId:
          String(row.item_id),

        shareAmount:
          Number(
            row.share_amount || 0
          )
      })
    );

  const assignedByItem = {};

  for (const selection of selections) {
    assignedByItem[
      selection.itemId
    ] = roundMoney(
      (
        assignedByItem[
          selection.itemId
        ] || 0
      ) +
      selection.shareAmount
    );
  }

  return {
    hasActiveBill:
      bill.status === "active",

    bill: {
      billId,

      billName:
        String(bill.title || ""),

      storeName:
        String(
          bill.restaurant_name || ""
        ),

      address:
        String(bill.address || ""),

      date:
        String(
          bill.receipt_date || ""
        ),

      time:
        String(
          bill.receipt_time || ""
        ),

      subtotal:
        Number(
          bill.subtotal || 0
        ),

      tax:
        Number(
          bill.tax || 0
        ),

      tip:
        Number(
          bill.tip || 0
        ),

      grandTotal:
        Number(
          bill.grand_total || 0
        ),

      status:
        bill.status === "active"
          ? "OPEN"
          : "ARCHIVED",

      createdAt:
        bill.created_at || "",

      updatedAt:
        bill.updated_at || ""
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

async function saveBill(
  env,
  inputBill
) {
  const bill =
    normalizeBillInput(
      inputBill
    );

  const activeBill =
    await env.DB
      .prepare(`
        SELECT *
        FROM bills
        WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .first();

  const requestedBillId =
    String(
      inputBill.billId || ""
    ).trim();

  if (requestedBillId) {
    if (
      !activeBill ||
      String(
        activeBill.bill_id
      ) !== requestedBillId
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

    await createNewBill(
      env,
      bill
    );
  }

  return getAppState(env);
}


function normalizeBillInput(bill) {
  const rawPeople =
    Array.isArray(
      bill.people
    )
      ? bill.people
      : [];

  const people = [];

  rawPeople.forEach(
    (person, index) => {
      const value =
        typeof person === "string"
          ? {
              name: person
            }
          : (
              person || {}
            );

      const name =
        String(
          value.name || ""
        ).trim();

      if (!name) {
        return;
      }

      const duplicate =
        people.some(
          existing =>
            existing.name
              .toLowerCase() ===
            name.toLowerCase()
        );

      if (duplicate) {
        throw new Error(
          "Participant names must be unique."
        );
      }

      const requestedColor =
        String(
          value.color || ""
        )
          .trim()
          .toLowerCase();

      people.push({
        personId:
          String(
            value.personId || ""
          ).trim(),

        name,

        sortOrder:
          index + 1,

        color:
          PERSON_COLOR_KEYS.includes(
            requestedColor
          )
            ? requestedColor
            : ""
      });
    }
  );

  if (!people.length) {
    throw new Error(
      "Add at least one participant."
    );
  }


  // Assign unused colors automatically.
  const usedColors = {};

  people.forEach(
    (person, index) => {
      if (
        !person.color ||
        usedColors[
          person.color
        ]
      ) {
        person.color =
          firstAvailablePersonColor(
            usedColors,
            index
          );
      }

      usedColors[
        person.color
      ] = true;
    }
  );


  const rawItems =
    Array.isArray(
      bill.items
    )
      ? bill.items
      : [];

  if (!rawItems.length) {
    throw new Error(
      "The bill must have at least one line item."
    );
  }


  const items =
    rawItems.map(
      (item, index) => {
        const name =
          String(
            item.name || ""
          ).trim();

        const lineTotal =
          Number(
            item.lineTotal
          );

        if (
          !name ||
          !Number.isFinite(
            lineTotal
          ) ||
          lineTotal < 0
        ) {
          throw new Error(
            "Every item needs a name and valid line total."
          );
        }

        const assignments =
          Array.isArray(
            item.assignments
          )
            ? item.assignments
                .map(
                  assignment => ({
                    personId:
                      String(
                        assignment.personId ||
                        ""
                      ).trim(),

                    name:
                      String(
                        assignment.name ||
                        ""
                      ).trim(),

                    shareAmount:
                      roundMoney(
                        Number(
                          assignment.shareAmount ||
                          0
                        )
                      )
                  })
                )
                .filter(
                  assignment =>
                    assignment.shareAmount >
                    0
                )
            : [];

        return {
          itemId:
            String(
              item.itemId || ""
            ).trim(),

          name,

          quantity:
            numberOrNull(
              item.quantity
            ),

          unitPrice:
            numberOrNull(
              item.unitPrice
            ),

          lineTotal:
            roundMoney(
              lineTotal
            ),

          sortOrder:
            index + 1,

          assignments,

          assignmentsTouched:
            Boolean(
              item.assignmentsTouched
            )
        };
      }
    );


  return {
    billName:
      String(
        bill.billName || ""
      ).trim() ||
      "Shared Bill",

    storeName:
      String(
        bill.storeName || ""
      ).trim(),

    address:
      String(
        bill.address || ""
      ).trim(),

    date:
      String(
        bill.date || ""
      ).trim(),

    time:
      String(
        bill.time || ""
      ).trim(),

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


// ============================================================
// CREATE NEW BILL
// ============================================================

async function createNewBill(
  env,
  bill
) {
  const billId =
    crypto.randomUUID();

  // Generate IDs before
  // creating assignments.
  bill.people.forEach(
    person => {
      person.personId =
        crypto.randomUUID();
    }
  );

  bill.items.forEach(
    item => {
      item.itemId =
        crypto.randomUUID();
    }
  );

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


  for (
    const person
    of bill.people
  ) {
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


  for (
    const item
    of bill.items
  ) {
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


  // First create the bill,
  // people and items.
  await env.DB.batch(
    statements
  );

  await applyAdminAssignments(
    env,
    billId,
    bill.people,
    bill.items
  );
}


// ============================================================
// UPDATE EXISTING BILL
// ============================================================

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
    existingPeopleResult.results ||
    [];

  const existingItems =
    existingItemsResult.results ||
    [];

  const existingSelections =
    existingSelectionsResult.results ||
    [];


  // Resolve participant IDs.
  for (
    const person
    of bill.people
  ) {
    const idMatch =
      existingPeople.find(
        row =>
          String(
            row.person_id
          ) ===
          person.personId
      );

    if (idMatch) {
      continue;
    }

    const nameMatch =
      existingPeople.find(
        row =>
          String(
            row.name || ""
          ).toLowerCase() ===
          person.name.toLowerCase()
      );

    person.personId =
      nameMatch
        ? String(
            nameMatch.person_id
          )
        : crypto.randomUUID();
  }


  // Resolve item IDs.
  for (
    const item
    of bill.items
  ) {
    const idMatch =
      existingItems.find(
        row =>
          String(
            row.item_id
          ) ===
          item.itemId
      );

    if (!idMatch) {
      item.itemId =
        crypto.randomUUID();
    }


    const currentlyAssigned =
      item.assignmentsTouched
        ? item.assignments.reduce(
            (
              sum,
              assignment
            ) =>
              sum +
              Number(
                assignment.shareAmount ||
                0
              ),
            0
          )
        : existingSelections
            .filter(
              row =>
                String(
                  row.item_id
                ) ===
                item.itemId
            )
            .reduce(
              (
                sum,
                row
              ) =>
                sum +
                Number(
                  row.share_amount ||
                  0
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
  for (
    const person
    of bill.people
  ) {
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
  for (
    const item
    of bill.items
  ) {
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


  await env.DB.batch(
    statements
  );


  // Remove people Admin
  // explicitly deleted.
  const personIdsToKeep =
    bill.people.map(
      person =>
        person.personId
    );

  await deleteRowsNotInList(
    env,
    "people",
    "person_id",
    billId,
    personIdsToKeep
  );


  // Remove items Admin
  // explicitly deleted.
  const itemIdsToKeep =
    bill.items.map(
      item =>
        item.itemId
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
      item =>
        item.assignmentsTouched
    );

  if (!touchedItems.length) {
    return;
  }

  const peopleById = {};
  const peopleByName = {};

  for (
    const person
    of people
  ) {
    peopleById[
      person.personId
    ] = person;

    peopleByName[
      person.name.toLowerCase()
    ] = person;
  }


  for (
    const item
    of touchedItems
  ) {
    const assignments =
      item.assignments || [];

    const itemTotal =
      roundMoney(
        assignments.reduce(
          (
            sum,
            assignment
          ) =>
            sum +
            Number(
              assignment.shareAmount ||
              0
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
        formatMoneyForError(
          itemTotal
        ) +
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


    for (
      const assignment
      of assignments
    ) {
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


    await env.DB.batch(
      statements
    );
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

  if (
    !state.hasActiveBill
  ) {
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


  for (
    const selection
    of submitted
  ) {
    const itemId =
      String(
        selection.itemId || ""
      );

    const amount =
      roundMoney(
        Number(
          selection.shareAmount ||
          0
        )
      );


    if (amount < 0) {
      throw new Error(
        "Item shares cannot be negative."
      );
    }

    submittedMap[
      itemId
    ] = amount;
  }


  for (
    const item
    of state.items
  ) {
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
          (
            sum,
            selection
          ) =>
            sum +
            Number(
              selection.shareAmount ||
              0
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
      Number(
        item.lineTotal
      ) +
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


  for (
    const item
    of state.items
  ) {
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

  if (
    !state.hasActiveBill
  ) {
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
        candidate.color ===
          color
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


  if (
    !result.meta?.changes
  ) {
    throw new Error(
      "The selected participant could not be updated."
    );
  }


  return getAppState(env);
}


// ============================================================
// ARCHIVE / HISTORY
// ============================================================

async function getBillStateById(
  env,
  billId
) {
  if (!billId) {
    throw new Error(
      "Bill ID is required."
    );
  }

  const bill =
    await getBillById(
      env,
      billId
    );

  if (!bill) {
    throw new Error(
      "The bill could not be found."
    );
  }

  return buildBillState(
    env,
    bill
  );
}


async function archiveActiveBill(
  env
) {
  const result =
    await env.DB
      .prepare(`
        UPDATE bills
        SET
          status = 'archived',
          archived_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE status = 'active'
      `)
      .run();


  if (
    !result.meta?.changes
  ) {
    throw new Error(
      "There is no active bill to archive."
    );
  }
}


async function getBillHistory(
  env
) {
  const result =
    await env.DB
      .prepare(`
        SELECT
          b.*,

          (
            SELECT COUNT(*)
            FROM people p
            WHERE p.bill_id = b.bill_id
          ) AS people_count,

          (
            SELECT COUNT(*)
            FROM items i
            WHERE i.bill_id = b.bill_id
          ) AS item_count

        FROM bills b

        WHERE b.status = 'archived'

        ORDER BY b.updated_at DESC
      `)
      .all();


  return (
    result.results || []
  ).map(
    row => ({
      billId:
        String(
          row.bill_id
        ),

      billName:
        String(
          row.title ||
          "Shared Bill"
        ),

      storeName:
        String(
          row.restaurant_name ||
          ""
        ),

      date:
        String(
          row.receipt_date ||
          ""
        ),

      subtotal:
        Number(
          row.subtotal ||
          0
        ),

      tax:
        Number(
          row.tax ||
          0
        ),

      tip:
        Number(
          row.tip ||
          0
        ),

      grandTotal:
        Number(
          row.grand_total ||
          0
        ),

      status:
        "ARCHIVED",

      updatedAt:
        String(
          row.updated_at ||
          ""
        ),

      peopleCount:
        Number(
          row.people_count ||
          0
        ),

      itemCount:
        Number(
          row.item_count ||
          0
        )
    })
  );
}


async function restoreBill(
  env,
  billId
) {
  if (!billId) {
    throw new Error(
      "Choose a bill to restore."
    );
  }

  const target =
    await getBillById(
      env,
      billId
    );

  if (!target) {
    throw new Error(
      "The archived bill was not found."
    );
  }


  await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE bills
        SET
          status = 'archived',
          archived_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE status = 'active'
          AND bill_id <> ?
      `)
      .bind(
        billId
      ),

    env.DB
      .prepare(`
        UPDATE bills
        SET
          status = 'active',
          archived_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE bill_id = ?
      `)
      .bind(
        billId
      )
  ]);


  return getAppState(env);
}


async function deleteArchivedBill(
  env,
  billId
) {
  if (!billId) {
    throw new Error(
      "Choose an archived bill to delete."
    );
  }

  const bill =
    await getBillById(
      env,
      billId
    );

  if (!bill) {
    throw new Error(
      "The archived bill was not found."
    );
  }

  if (
    bill.status === "active"
  ) {
    throw new Error(
      "The active bill cannot be deleted. Archive it first."
    );
  }


  // Explicitly delete child rows too,
  // so this is safe even if an older
  // version of the tables lacked
  // ON DELETE CASCADE.
  await env.DB.batch([
    env.DB
      .prepare(`
        DELETE FROM selections
        WHERE bill_id = ?
      `)
      .bind(
        billId
      ),

    env.DB
      .prepare(`
        DELETE FROM items
        WHERE bill_id = ?
      `)
      .bind(
        billId
      ),

    env.DB
      .prepare(`
        DELETE FROM people
        WHERE bill_id = ?
      `)
      .bind(
        billId
      ),

    env.DB
      .prepare(`
        DELETE FROM bills
        WHERE bill_id = ?
          AND status = 'archived'
      `)
      .bind(
        billId
      )
  ]);
}


// ============================================================
// GEMINI RECEIPT ANALYSIS
// ============================================================

async function analyzeReceiptImageWithGemini(
  env,
  mimeType,
  imageBase64
) {
  mimeType =
    String(
      mimeType || ""
    ).trim();

  imageBase64 =
    String(
      imageBase64 || ""
    ).trim();


  if (
    !mimeType.startsWith(
      "image/"
    ) ||
    !imageBase64
  ) {
    throw new Error(
      "A valid receipt image is required."
    );
  }


  const prompt =
    buildReceiptPrompt(
      "Analyze this purchase receipt image directly. Read the image yourself."
    );


  return callGemini(
    env,
    [
      {
        text: prompt
      },

      {
        inlineData: {
          mimeType,
          data:
            imageBase64
        }
      }
    ]
  );
}


async function analyzeReceiptTextWithGemini(
  env,
  ocrText
) {
  ocrText =
    String(
      ocrText || ""
    ).trim();


  if (!ocrText) {
    throw new Error(
      "OCR text is required."
    );
  }


  const prompt =
    buildReceiptPrompt(
      "Analyze the following OCR text from a purchase receipt."
    ) +
    "\n\nOCR TEXT:\n" +
    ocrText;


  return callGemini(
    env,
    [
      {
        text: prompt
      }
    ]
  );
}


function buildReceiptPrompt(
  opening
) {
  return [
    opening,
    "",
    "Return the best reasonable structured interpretation.",
    "",
    "Rules:",
    "- Correct obvious reading mistakes only when context is strong.",
    "- Do not invent unsupported purchases.",
    "- A number before an item may be its quantity.",
    "- Distinguish unit price from full line total.",
    "- If quantity is greater than 1 and only a line total is shown, infer unit price when reasonable.",
    "- Use null when a value cannot reasonably be determined.",
    "- Tip must be actual paid tip or mandatory gratuity.",
    "- Never use suggested additional tip amounts as the paid tip.",
    "- Verify subtotal + tax + tip approximately equals grand total.",
    "- Put uncertainty or arithmetic mismatches in warnings.",
    "- Confidence must be from 0 through 1."
  ].join("\n");
}


async function callGemini(
  env,
  parts
) {
  if (
    !env.GEMINI_API_KEY
  ) {
    throw new Error(
      "GEMINI_API_KEY secret is not configured."
    );
  }


  const requestBody = {
    contents: [
      {
        role:
          "user",

        parts
      }
    ],

    generationConfig: {
      temperature:
        0.1,

      responseMimeType:
        "application/json",

      responseJsonSchema:
        getReceiptSchema()
    }
  };


  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(
      GEMINI_MODEL
    ) +
    ":generateContent?key=" +
    encodeURIComponent(
      env.GEMINI_API_KEY
    );


  const response =
    await fetch(
      endpoint,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            requestBody
          )
      }
    );


  const responseText =
    await response.text();


  if (!response.ok) {
    throw new Error(
      "Gemini API error " +
      response.status +
      ": " +
      responseText
    );
  }


  const responseJson =
    JSON.parse(
      responseText
    );


  const resultText =
    responseJson
      ?.candidates?.[0]
      ?.content?.parts?.[0]
      ?.text;


  if (!resultText) {
    throw new Error(
      "Gemini returned no structured receipt result."
    );
  }


  return JSON.parse(
    resultText
  );
}


function getReceiptSchema() {
  return {
    type:
      "object",

    properties: {
      storeName: {
        type: [
          "string",
          "null"
        ]
      },

      address: {
        type: [
          "string",
          "null"
        ]
      },

      date: {
        type: [
          "string",
          "null"
        ],

        description:
          "Use YYYY-MM-DD when reasonably determinable."
      },

      time: {
        type: [
          "string",
          "null"
        ],

        description:
          "Use HH:MM in 24-hour time when reasonably determinable."
      },

      items: {
        type:
          "array",

        items: {
          type:
            "object",

          properties: {
            name: {
              type: [
                "string",
                "null"
              ]
            },

            quantity: {
              type: [
                "number",
                "null"
              ]
            },

            unitPrice: {
              type: [
                "number",
                "null"
              ]
            },

            lineTotal: {
              type: [
                "number",
                "null"
              ]
            }
          },

          required: [
            "name",
            "quantity",
            "unitPrice",
            "lineTotal"
          ],

          additionalProperties:
            false
        }
      },

      subtotal: {
        type: [
          "number",
          "null"
        ]
      },

      tax: {
        type: [
          "number",
          "null"
        ]
      },

      tip: {
        type: [
          "number",
          "null"
        ]
      },

      grandTotal: {
        type: [
          "number",
          "null"
        ]
      },

      confidence: {
        type:
          "number",

        minimum:
          0,

        maximum:
          1
      },

      warnings: {
        type:
          "array",

        items: {
          type:
            "string"
        }
      }
    },

    required: [
      "storeName",
      "address",
      "date",
      "time",
      "items",
      "subtotal",
      "tax",
      "tip",
      "grandTotal",
      "confidence",
      "warnings"
    ],

    additionalProperties:
      false
  };
}

// ============================================================
// POLL
// ============================================================

function verifyPollAdmin(env, candidate) {
  if (!env.POLL_ADMIN_CODE) {
    throw new Error(
      "POLL_ADMIN_CODE secret is not configured."
    );
  }

  if (
    String(candidate || "") !==
    String(env.POLL_ADMIN_CODE)
  ) {
    throw new Error(
      "Incorrect admin code."
    );
  }
}


// ============================================================
// POLL LOGIN
// ============================================================

async function pollLogin(env, request) {
  const code =
    String(request.code || "")
      .trim();

  if (!code) {
    throw new Error(
      "Enter a session code."
    );
  }


  // Admin login
  if (
    env.POLL_ADMIN_CODE &&
    code === String(env.POLL_ADMIN_CODE)
  ) {
    return {
      mode: "admin"
    };
  }


  // Normal session login
  const session =
    await env.POLL_DB
      .prepare(`
        SELECT
          session_id,
          session_name,
          session_code,
          start_date,
          end_date,
          allowed_days,
          default_start_hour,
          default_end_hour
        FROM poll_sessions
        WHERE UPPER(session_code) = UPPER(?)
          AND is_active = 1
        LIMIT 1
      `)
      .bind(code)
      .first();


  if (!session) {
    throw new Error(
      "Invalid session code."
    );
  }


  return {
    mode: "session",

    session: {
      sessionId:
        String(session.session_id),

      sessionName:
        String(session.session_name),

      sessionCode:
        String(session.session_code),

      startDate:
        String(
          session.start_date || ""
        ),

      endDate:
        String(
          session.end_date || ""
        ),

      allowedDays:
        parsePollAllowedDays(
          session.allowed_days
        ),

      defaultStartHour:
        numberOrNull(
          session.default_start_hour
        ),

      defaultEndHour:
        numberOrNull(
          session.default_end_hour
        )
    }
  };
}


// ============================================================
// LOAD POLL
// ============================================================

async function loadPollState(
  env,
  request
) {
  const session =
    await getPollSessionByCode(
      env,
      request.sessionCode
    );


  const [
    peopleResult,
    availabilityResult
  ] = await Promise.all([

    env.POLL_DB
      .prepare(`
        SELECT
          person_id,
          name,
          sort_order
        FROM poll_people
        WHERE session_id = ?
        ORDER BY
          sort_order,
          name
      `)
      .bind(
        session.session_id
      )
      .all(),


    env.POLL_DB
      .prepare(`
        SELECT
          person_id,
          date_key,
          am,
          pm,
          exact_times
        FROM poll_availability
        WHERE session_id = ?
          AND event_id IS NULL
        ORDER BY
          person_id,
          date_key
      `)
      .bind(
        session.session_id
      )
      .all()
  ]);


  const people =
    (peopleResult.results || [])
      .map(row => ({
        personId:
          String(row.person_id),

        name:
          String(row.name || "")
      }));


  const peopleById = {};

  for (const person of people) {
    peopleById[
      person.personId
    ] = person;
  }


  const availability = {};

  for (
    const row
    of availabilityResult.results || []
  ) {
    const personId =
      String(
        row.person_id || ""
      );

    const person =
      peopleById[
        personId
      ];

    if (!person) {
      continue;
    }


    const dateKey =
      String(
        row.date_key || ""
      );

    if (!dateKey) {
      continue;
    }


    if (
      !availability[
        person.name
      ]
    ) {
      availability[
        person.name
      ] = {};
    }


    let exactTimes = [];

    try {
      exactTimes =
        JSON.parse(
          String(
            row.exact_times ||
            "[]"
          )
        );
    } catch {
      exactTimes = [];
    }


    availability[
      person.name
    ][dateKey] = {
      am:
        Boolean(
          row.am
        ),

      pm:
        Boolean(
          row.pm
        ),

      exactTimes:
        Array.isArray(
          exactTimes
        )
          ? exactTimes
          : []
    };
  }


  return {
    session: {
      sessionId:
        String(
          session.session_id
        ),

      sessionName:
        String(
          session.session_name
        ),

      sessionCode:
        String(
          session.session_code
        ),

      startDate:
        String(
          session.start_date || ""
        ),

      endDate:
        String(
          session.end_date || ""
        ),

      allowedDays:
        parsePollAllowedDays(
          session.allowed_days
        ),

      defaultStartHour:
        numberOrNull(
          session.default_start_hour
        ),

      defaultEndHour:
        numberOrNull(
          session.default_end_hour
        )
    },

    people,

    availability
  };
}


// ============================================================
// SAVE POLL AVAILABILITY
// ============================================================

async function savePollAvailability(
  env,
  request
) {
  const session =
    await getPollSessionByCode(
      env,
      request.sessionCode
    );


  const personId =
    String(
      request.personId || ""
    ).trim();


  const dateKey =
    String(
      request.date || ""
    ).trim();


  if (!personId) {
    throw new Error(
      "Choose a person."
    );
  }


  if (!dateKey) {
    throw new Error(
      "Date is required."
    );
  }


  validatePollAvailabilityDate(
    session,
    dateKey
  );


  const person =
    await env.POLL_DB
      .prepare(`
        SELECT
          person_id
        FROM poll_people
        WHERE person_id = ?
          AND session_id = ?
        LIMIT 1
      `)
      .bind(
        personId,
        session.session_id
      )
      .first();


  if (!person) {
    throw new Error(
      "That person does not belong to this session."
    );
  }


  const exactTimes =
    normalizePollTimes(
      request.times
    );


  const cleared =
    Boolean(
      request.cleared
    ) ||
    !exactTimes.length;


  if (cleared) {
    await env.POLL_DB
      .prepare(`
        DELETE FROM poll_availability
        WHERE session_id = ?
          AND person_id = ?
          AND event_id IS NULL
          AND date_key = ?
      `)
      .bind(
        session.session_id,
        personId,
        dateKey
      )
      .run();

  } else {

    await env.POLL_DB
      .prepare(`
        INSERT INTO poll_availability (
          availability_id,
          session_id,
          person_id,
          event_id,
          date_key,
          am,
          pm,
          exact_times,
          created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, NULL, ?,
          0, 0, ?,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )

        ON CONFLICT(
          session_id,
          person_id,
          date_key
        )
        WHERE event_id IS NULL

        DO UPDATE SET
          am = 0,
          pm = 0,
          exact_times =
            excluded.exact_times,
          updated_at =
            CURRENT_TIMESTAMP
      `)
      .bind(
        crypto.randomUUID(),
        session.session_id,
        personId,
        dateKey,
        JSON.stringify(
          exactTimes
        )
      )
      .run();
  }


  return loadPollState(
    env,
    {
      sessionCode:
        request.sessionCode
    }
  );
}

// ============================================================
// PARTICIPANT - ADD YOURSELF
// ============================================================

async function addPollPersonSelf(
  env,
  request
) {
  const session =
    await getPollSessionByCode(
      env,
      request.sessionCode
    );


  const name =
    String(
      request.name || ""
    ).trim();


  if (!name) {
    throw new Error(
      "Enter your name."
    );
  }


  if (name.length > 50) {
    throw new Error(
      "Name is too long."
    );
  }


  const existing =
    await env.POLL_DB
      .prepare(`
        SELECT
          person_id
        FROM poll_people
        WHERE session_id = ?
          AND LOWER(name) = LOWER(?)
        LIMIT 1
      `)
      .bind(
        session.session_id,
        name
      )
      .first();


  if (existing) {
    throw new Error(
      "That name is already in this session."
    );
  }


  const orderRow =
    await env.POLL_DB
      .prepare(`
        SELECT
          COALESCE(
            MAX(sort_order),
            0
          ) + 1 AS next_order
        FROM poll_people
        WHERE session_id = ?
      `)
      .bind(
        session.session_id
      )
      .first();


  const personId =
    crypto.randomUUID();


  await env.POLL_DB
    .prepare(`
      INSERT INTO poll_people (
        person_id,
        session_id,
        name,
        sort_order,
        created_at
      )
      VALUES (
        ?, ?, ?, ?,
        CURRENT_TIMESTAMP
      )
    `)
    .bind(
      personId,
      session.session_id,
      name,
      Number(
        orderRow?.next_order || 1
      )
    )
    .run();


  const state =
    await loadPollState(
      env,
      {
        sessionCode:
          request.sessionCode
      }
    );


  return {
    ...state,

    addedPersonId:
      personId
  };
}

// ============================================================
// POLL ADMIN STATE
// ============================================================

async function getPollAdminState(env) {
  const [
    sessionsResult,
    peopleResult
  ] = await Promise.all([

    env.POLL_DB
      .prepare(`
        SELECT
          session_id,
          session_name,
          session_code,
          start_date,
          end_date,
          allowed_days,
          default_start_hour,
          default_end_hour,
          is_active,
          created_at,
          updated_at
        FROM poll_sessions
        ORDER BY
          session_name
      `)
      .all(),


    env.POLL_DB
      .prepare(`
        SELECT
          person_id,
          session_id,
          name,
          sort_order
        FROM poll_people
        ORDER BY
          session_id,
          sort_order,
          name
      `)
      .all()
  ]);


  const sessions =
    (sessionsResult.results || [])
      .map(row => {

        const sessionId =
          String(
            row.session_id
          );


        return {
          sessionId,

          sessionName:
            String(
              row.session_name ||
              ""
            ),

          sessionCode:
            String(
              row.session_code ||
              ""
            ),

          startDate:
            String(
              row.start_date ||
              ""
            ),

          endDate:
            String(
              row.end_date ||
              ""
            ),

          allowedDays:
            parsePollAllowedDays(
              row.allowed_days
            ),

          defaultStartHour:
            numberOrNull(
              row.default_start_hour
            ),

          defaultEndHour:
            numberOrNull(
              row.default_end_hour
            ),

          isActive:
            Boolean(
              row.is_active
            ),

          people:
            (peopleResult.results || [])
              .filter(
                person =>
                  String(
                    person.session_id
                  ) ===
                  sessionId
              )
              .map(person => ({
                personId:
                  String(
                    person.person_id
                  ),

                name:
                  String(
                    person.name ||
                    ""
                  )
              }))
        };
      });


  return {
    sessions
  };
}


// ============================================================
// CREATE SESSION
// ============================================================

async function createPollSession(
  env,
  request
) {
  const sessionName =
    String(
      request.sessionName || ""
    ).trim();


  const sessionCode =
    String(
      request.sessionCode || ""
    ).trim();


  const startDate =
    normalizeOptionalText(
      request.startDate
    );


  const endDate =
    normalizeOptionalText(
      request.endDate
    );


  const allowedDays =
    normalizePollAllowedDays(
      request.allowedDays
    );


  const defaultStartHour =
    normalizePollHour(
      request.defaultStartHour,
      "Default start time"
    );


  const defaultEndHour =
    normalizePollHour(
      request.defaultEndHour,
      "Default end time"
    );


  if (!sessionName) {
    throw new Error(
      "Session name is required."
    );
  }


  if (!sessionCode) {
    throw new Error(
      "Session code is required."
    );
  }


  validatePollDateRange(
    startDate,
    endDate
  );


  if (
    env.POLL_ADMIN_CODE &&
    sessionCode ===
      String(
        env.POLL_ADMIN_CODE
      )
  ) {
    throw new Error(
      "That code is reserved for admin access."
    );
  }


  const duplicate =
    await env.POLL_DB
      .prepare(`
        SELECT
          session_id
        FROM poll_sessions
        WHERE UPPER(session_code) =
          UPPER(?)
        LIMIT 1
      `)
      .bind(
        sessionCode
      )
      .first();


  if (duplicate) {
    throw new Error(
      "That session code is already in use."
    );
  }


  await env.POLL_DB
    .prepare(`
      INSERT INTO poll_sessions (
        session_id,
        session_name,
        session_code,
        start_date,
        end_date,
        allowed_days,
        default_start_hour,
        default_end_hour,
        is_active,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, 1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `)
    .bind(
      crypto.randomUUID(),
      sessionName,
      sessionCode,
      startDate,
      endDate,
      JSON.stringify(
        allowedDays
      ),
      defaultStartHour,
      defaultEndHour
    )
    .run();


  return getPollAdminState(env);
}


// ============================================================
// UPDATE SESSION
// ============================================================

async function updatePollSession(
  env,
  request
) {
  const sessionId =
    String(
      request.sessionId || ""
    ).trim();


  const sessionName =
    String(
      request.sessionName || ""
    ).trim();


  const sessionCode =
    String(
      request.sessionCode || ""
    ).trim();


  const startDate =
    normalizeOptionalText(
      request.startDate
    );


  const endDate =
    normalizeOptionalText(
      request.endDate
    );


  const allowedDays =
    normalizePollAllowedDays(
      request.allowedDays
    );


  const defaultStartHour =
    normalizePollHour(
      request.defaultStartHour,
      "Default start time"
    );


  const defaultEndHour =
    normalizePollHour(
      request.defaultEndHour,
      "Default end time"
    );


  if (
    !sessionId ||
    !sessionName ||
    !sessionCode
  ) {
    throw new Error(
      "Session name and code are required."
    );
  }


  validatePollDateRange(
    startDate,
    endDate
  );


  if (
    env.POLL_ADMIN_CODE &&
    sessionCode ===
      String(
        env.POLL_ADMIN_CODE
      )
  ) {
    throw new Error(
      "That code is reserved for admin access."
    );
  }


  const duplicate =
    await env.POLL_DB
      .prepare(`
        SELECT
          session_id
        FROM poll_sessions
        WHERE UPPER(session_code) =
          UPPER(?)
          AND session_id <> ?
        LIMIT 1
      `)
      .bind(
        sessionCode,
        sessionId
      )
      .first();


  if (duplicate) {
    throw new Error(
      "That session code is already in use."
    );
  }


  const result =
    await env.POLL_DB
      .prepare(`
        UPDATE poll_sessions
        SET
          session_name = ?,
          session_code = ?,
          start_date = ?,
          end_date = ?,
          allowed_days = ?,
          default_start_hour = ?,
          default_end_hour = ?,
          is_active = ?,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE session_id = ?
      `)
      .bind(
        sessionName,
        sessionCode,
        startDate,
        endDate,
        JSON.stringify(
          allowedDays
        ),
        defaultStartHour,
        defaultEndHour,
        request.isActive === false
          ? 0
          : 1,
        sessionId
      )
      .run();


  if (!result.meta?.changes) {
    throw new Error(
      "Session not found."
    );
  }


  return getPollAdminState(env);
}


// ============================================================
// DELETE SESSION
// ============================================================

async function deletePollSession(
  env,
  request
) {
  const sessionId =
    String(
      request.sessionId || ""
    ).trim();


  if (!sessionId) {
    throw new Error(
      "Session ID is required."
    );
  }


  // Explicit child deletion keeps this
  // safe regardless of FK settings.
  await env.POLL_DB.batch([

    env.POLL_DB
      .prepare(`
        DELETE FROM poll_availability
        WHERE session_id = ?
      `)
      .bind(
        sessionId
      ),

    env.POLL_DB
      .prepare(`
        DELETE FROM poll_events
        WHERE session_id = ?
      `)
      .bind(
        sessionId
      ),

    env.POLL_DB
      .prepare(`
        DELETE FROM poll_people
        WHERE session_id = ?
      `)
      .bind(
        sessionId
      ),

    env.POLL_DB
      .prepare(`
        DELETE FROM poll_sessions
        WHERE session_id = ?
      `)
      .bind(
        sessionId
      )
  ]);


  return getPollAdminState(env);
}


// ============================================================
// ADD PERSON
// ============================================================

async function addPollPerson(
  env,
  request
) {
  const sessionId =
    String(
      request.sessionId || ""
    ).trim();


  const name =
    String(
      request.name || ""
    ).trim();


  if (!sessionId || !name) {
    throw new Error(
      "Session and name are required."
    );
  }


  await verifyPollSessionId(
    env,
    sessionId
  );


  const existing =
    await env.POLL_DB
      .prepare(`
        SELECT
          person_id
        FROM poll_people
        WHERE session_id = ?
          AND LOWER(name) =
            LOWER(?)
        LIMIT 1
      `)
      .bind(
        sessionId,
        name
      )
      .first();


  if (existing) {
    throw new Error(
      "That person is already in this session."
    );
  }


  const orderRow =
    await env.POLL_DB
      .prepare(`
        SELECT
          COALESCE(
            MAX(sort_order),
            0
          ) + 1 AS next_order
        FROM poll_people
        WHERE session_id = ?
      `)
      .bind(
        sessionId
      )
      .first();


  await env.POLL_DB
    .prepare(`
      INSERT INTO poll_people (
        person_id,
        session_id,
        name,
        sort_order,
        created_at
      )
      VALUES (
        ?, ?, ?, ?,
        CURRENT_TIMESTAMP
      )
    `)
    .bind(
      crypto.randomUUID(),
      sessionId,
      name,
      Number(
        orderRow?.next_order ||
        1
      )
    )
    .run();


  return getPollAdminState(env);
}


// ============================================================
// DELETE PERSON
// ============================================================

async function deletePollPerson(
  env,
  request
) {
  const personId =
    String(
      request.personId || ""
    ).trim();


  if (!personId) {
    throw new Error(
      "Person ID is required."
    );
  }


  await env.POLL_DB.batch([

    env.POLL_DB
      .prepare(`
        DELETE FROM poll_availability
        WHERE person_id = ?
      `)
      .bind(
        personId
      ),

    env.POLL_DB
      .prepare(`
        DELETE FROM poll_people
        WHERE person_id = ?
      `)
      .bind(
        personId
      )
  ]);


  return getPollAdminState(env);
}


// ============================================================
// POLL HELPERS
// ============================================================

async function getPollSessionByCode(
  env,
  sessionCode
) {
  sessionCode =
    String(
      sessionCode || ""
    ).trim();


  if (!sessionCode) {
    throw new Error(
      "Session code is required."
    );
  }


  const session =
    await env.POLL_DB
      .prepare(`
        SELECT
          session_id,
          session_name,
          session_code,
          start_date,
          end_date,
          allowed_days,
          default_start_hour,
          default_end_hour
        FROM poll_sessions
        WHERE UPPER(session_code) =
          UPPER(?)
          AND is_active = 1
        LIMIT 1
      `)
      .bind(
        sessionCode
      )
      .first();


  if (!session) {
    throw new Error(
      "Session not found or inactive."
    );
  }


  return session;
}


async function verifyPollSessionId(
  env,
  sessionId
) {
  const session =
    await env.POLL_DB
      .prepare(`
        SELECT
          session_id
        FROM poll_sessions
        WHERE session_id = ?
        LIMIT 1
      `)
      .bind(
        sessionId
      )
      .first();


  if (!session) {
    throw new Error(
      "Session not found."
    );
  }
}


function normalizeOptionalText(value) {
  const text =
    String(
      value || ""
    ).trim();

  return text || null;
}


function parsePollAllowedDays(value) {
  try {
    const parsed =
      JSON.parse(
        String(
          value || "[]"
        )
      );


    if (!Array.isArray(parsed)) {
      return [];
    }


    const validDays = [
      "sun",
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
      "sat"
    ];


    return parsed
      .map(day =>
        String(
          day || ""
        )
          .trim()
          .toLowerCase()
      )
      .filter(day =>
        validDays.includes(
          day
        )
      );

  } catch {
    return [];
  }
}


function normalizePollAllowedDays(value) {
  const source =
    Array.isArray(value)
      ? value
      : [];


  const validDays = [
    "sun",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat"
  ];


  return [
    ...new Set(
      source
        .map(day =>
          String(
            day || ""
          )
            .trim()
            .toLowerCase()
        )
        .filter(day =>
          validDays.includes(
            day
          )
        )
    )
  ];
}


function normalizePollHour(
  value,
  label
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  const hour =
    Number(value);


  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23
  ) {
    throw new Error(
      label +
      " must be a whole hour from 0 through 23."
    );
  }


  return hour;
}


function validatePollDateRange(
  startDate,
  endDate
) {
  if (
    startDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(
      startDate
    )
  ) {
    throw new Error(
      "Start date must use YYYY-MM-DD."
    );
  }


  if (
    endDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(
      endDate
    )
  ) {
    throw new Error(
      "End date must use YYYY-MM-DD."
    );
  }


  if (
    startDate &&
    endDate &&
    endDate < startDate
  ) {
    throw new Error(
      "End date cannot be before start date."
    );
  }
}


function validatePollAvailabilityDate(
  session,
  dateKey
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      dateKey
    )
  ) {
    throw new Error(
      "Invalid availability date."
    );
  }


  const startDate =
    String(
      session.start_date || ""
    );


  const endDate =
    String(
      session.end_date || ""
    );


  if (
    startDate &&
    dateKey < startDate
  ) {
    throw new Error(
      "That date is before this session begins."
    );
  }


  if (
    endDate &&
    dateKey > endDate
  ) {
    throw new Error(
      "That date is after this session ends."
    );
  }


  const allowedDays =
    parsePollAllowedDays(
      session.allowed_days
    );


  if (!allowedDays.length) {
    return;
  }


  const parts =
    dateKey
      .split("-")
      .map(Number);


  const date =
    new Date(
      Date.UTC(
        parts[0],
        parts[1] - 1,
        parts[2]
      )
    );


  const dayKeys = [
    "sun",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat"
  ];


  const dayKey =
    dayKeys[
      date.getUTCDay()
    ];


  if (
    !allowedDays.includes(
      dayKey
    )
  ) {
    throw new Error(
      "That day is not available for this session."
    );
  }
}


function normalizePollTimes(value) {
  if (!Array.isArray(value)) {
    return [];
  }


  return [
    ...new Set(
      value
        .map(Number)
        .filter(hour =>
          Number.isInteger(hour) &&
          hour >= 0 &&
          hour <= 23
        )
    )
  ];
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
            preferredIndex ||
            0
          ) +
          offset
        ) %
        PERSON_COLOR_KEYS.length
      ];


    if (
      !usedColors[key]
    ) {
      return key;
    }
  }


  return PERSON_COLOR_KEYS[
    Number(
      preferredIndex ||
      0
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
    !Number.isFinite(
      number
    ) ||
    number < 0
  ) {
    throw new Error(
      "Enter a valid " +
      label +
      "."
    );
  }

  return roundMoney(
    number
  );
}


function numberOrNull(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  const number =
    Number(value);


  return Number.isFinite(
    number
  )
    ? number
    : null;
}


function roundMoney(
  value
) {
  return Math.round(
    (
      Number(
        value || 0
      ) +
      Number.EPSILON
    ) *
    100
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
        "Content-Type": "application/json; charset=utf-8",
        ...CORS_HEADERS
      }
    }
  );
}
