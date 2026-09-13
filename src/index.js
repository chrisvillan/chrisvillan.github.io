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
            
            case "pollBootstrap":
              return json({
                ok: true,
                ...(await getPollBootstrap(env))
              });

            case "pollLoadLive":
              return json({
                ok: true,
                state: await loadLivePollState(env)
              });


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
            
            
            case "pollAdminSaveSettings":
              verifyPollAdmin(env, body.adminCode);

              return json({
                ok: true,
                state: await savePollSettings(env, body)
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


  const statements = [
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
  ];


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


  await env.DB.batch(
    statements
  );


  await replaceBillAssignments(
    env,
    billId,
    bill.people,
    bill.items,
    true
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
    oldPeopleResult,
    oldItemsResult,
    oldSelectionsResult
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


  const oldPeople =
    oldPeopleResult.results || [];

  const oldItems =
    oldItemsResult.results || [];

  const oldSelections =
    oldSelectionsResult.results || [];


  const oldPersonIds =
    new Set(
      oldPeople.map(
        row =>
          String(
            row.person_id
          )
      )
    );

  const oldItemIds =
    new Set(
      oldItems.map(
        row =>
          String(
            row.item_id
          )
      )
    );


  const usedPersonIds =
    new Set();

  bill.people.forEach(
    person => {
      const requestedId =
        String(
          person.personId || ""
        ).trim();

      if (
        requestedId &&
        oldPersonIds.has(
          requestedId
        ) &&
        !usedPersonIds.has(
          requestedId
        )
      ) {
        person.personId =
          requestedId;

        usedPersonIds.add(
          requestedId
        );

        return;
      }

      person.personId =
        crypto.randomUUID();

      usedPersonIds.add(
        person.personId
      );
    }
  );


  const usedItemIds =
    new Set();

  bill.items.forEach(
    item => {
      const requestedId =
        String(
          item.itemId || ""
        ).trim();

      if (
        requestedId &&
        oldItemIds.has(
          requestedId
        ) &&
        !usedItemIds.has(
          requestedId
        )
      ) {
        item.itemId =
          requestedId;

        usedItemIds.add(
          requestedId
        );

        return;
      }

      item.itemId =
        crypto.randomUUID();

      usedItemIds.add(
        item.itemId
      );
    }
  );


  const statements = [
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
          updated_at =
            CURRENT_TIMESTAMP
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
      ),

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
      )
  ];


  await env.DB.batch(
    statements
  );


  const insertStatements = [];


  for (
    const person
    of bill.people
  ) {
    insertStatements.push(
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
    insertStatements.push(
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


  if (
    insertStatements.length
  ) {
    await env.DB.batch(
      insertStatements
    );
  }


  await restoreExistingSelections(
    env,
    billId,
    bill.people,
    bill.items,
    oldPeople,
    oldItems,
    oldSelections
  );


  await replaceBillAssignments(
    env,
    billId,
    bill.people,
    bill.items,
    false
  );
}


// ============================================================
// RESTORE EXISTING SELECTIONS
// ============================================================

async function restoreExistingSelections(
  env,
  billId,
  newPeople,
  newItems,
  oldPeople,
  oldItems,
  oldSelections
) {
  const newPersonIds =
    new Set(
      newPeople.map(
        person =>
          person.personId
      )
    );

  const newItemIds =
    new Set(
      newItems.map(
        item =>
          item.itemId
      )
    );


  const statements = [];


  for (
    const selection
    of oldSelections
  ) {
    const personId =
      String(
        selection.person_id
      );

    const itemId =
      String(
        selection.item_id
      );

    if (
      !newPersonIds.has(
        personId
      ) ||
      !newItemIds.has(
        itemId
      )
    ) {
      continue;
    }


    statements.push(
      env.DB
        .prepare(`
          INSERT INTO selections (
            selection_id,
            bill_id,
            person_id,
            item_id,
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
          personId,
          itemId,
          Number(
            selection.share_amount ||
            0
          )
        )
    );
  }


  if (
    statements.length
  ) {
    await env.DB.batch(
      statements
    );
  }
}


// ============================================================
// ADMIN ASSIGNMENTS
// ============================================================

async function replaceBillAssignments(
  env,
  billId,
  people,
  items,
  isNewBill
) {
  const personById =
    new Map(
      people.map(
        person => [
          person.personId,
          person
        ]
      )
    );

  const personByName =
    new Map(
      people.map(
        person => [
          person.name
            .toLowerCase(),
          person
        ]
      )
    );


  for (
    const item
    of items
  ) {
    if (
      !isNewBill &&
      !item.assignmentsTouched
    ) {
      continue;
    }


    await env.DB
      .prepare(`
        DELETE FROM selections
        WHERE bill_id = ?
          AND item_id = ?
      `)
      .bind(
        billId,
        item.itemId
      )
      .run();


    if (
      !item.assignments.length
    ) {
      continue;
    }


    const statements = [];


    for (
      const assignment
      of item.assignments
    ) {
      let person = null;


      if (
        assignment.personId &&
        personById.has(
          assignment.personId
        )
      ) {
        person =
          personById.get(
            assignment.personId
          );
      }


      if (
        !person &&
        assignment.name
      ) {
        person =
          personByName.get(
            assignment.name
              .toLowerCase()
          );
      }


      if (!person) {
        continue;
      }


      const shareAmount =
        roundMoney(
          Number(
            assignment.shareAmount ||
            0
          )
        );


      if (
        shareAmount <= 0
      ) {
        continue;
      }


      statements.push(
        env.DB
          .prepare(`
            INSERT INTO selections (
              selection_id,
              bill_id,
              person_id,
              item_id,
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
            person.personId,
            item.itemId,
            shareAmount
          )
      );
    }


    if (
      statements.length
    ) {
      await env.DB.batch(
        statements
      );
    }
  }
}


// ============================================================
// PARTICIPANT SELECTION
// ============================================================

async function saveParticipantSelection(
  env,
  request
) {
  const billId =
    String(
      request.billId || ""
    ).trim();

  const personId =
    String(
      request.personId || ""
    ).trim();

  const selections =
    Array.isArray(
      request.selections
    )
      ? request.selections
      : [];


  if (
    !billId ||
    !personId
  ) {
    throw new Error(
      "Bill and participant are required."
    );
  }


  const bill =
    await env.DB
      .prepare(`
        SELECT
          bill_id,
          status
        FROM bills
        WHERE bill_id = ?
        LIMIT 1
      `)
      .bind(
        billId
      )
      .first();


  if (
    !bill ||
    bill.status !== "active"
  ) {
    throw new Error(
      "This bill is no longer active."
    );
  }


  const person =
    await env.DB
      .prepare(`
        SELECT
          person_id
        FROM people
        WHERE bill_id = ?
          AND person_id = ?
        LIMIT 1
      `)
      .bind(
        billId,
        personId
      )
      .first();


  if (!person) {
    throw new Error(
      "Participant not found."
    );
  }


  const itemsResult =
    await env.DB
      .prepare(`
        SELECT
          item_id,
          line_total
        FROM items
        WHERE bill_id = ?
      `)
      .bind(
        billId
      )
      .all();


  const itemById =
    new Map(
      (
        itemsResult.results ||
        []
      ).map(
        row => [
          String(
            row.item_id
          ),
          {
            itemId:
              String(
                row.item_id
              ),

            lineTotal:
              Number(
                row.line_total ||
                0
              )
          }
        ]
      )
    );


  const normalized = [];


  for (
    const selection
    of selections
  ) {
    const itemId =
      String(
        selection.itemId || ""
      ).trim();

    const shareAmount =
      roundMoney(
        Number(
          selection.shareAmount ||
          0
        )
      );


    if (
      !itemId ||
      !itemById.has(
        itemId
      )
    ) {
      continue;
    }


    if (
      !Number.isFinite(
        shareAmount
      ) ||
      shareAmount < 0
    ) {
      throw new Error(
        "Invalid item share."
      );
    }


    if (
      shareAmount === 0
    ) {
      continue;
    }


    normalized.push({
      itemId,
      shareAmount
    });
  }


  const duplicateCheck =
    new Set();


  for (
    const selection
    of normalized
  ) {
    if (
      duplicateCheck.has(
        selection.itemId
      )
    ) {
      throw new Error(
        "Duplicate item selection."
      );
    }

    duplicateCheck.add(
      selection.itemId
    );
  }


  const existingResult =
    await env.DB
      .prepare(`
        SELECT
          person_id,
          item_id,
          share_amount
        FROM selections
        WHERE bill_id = ?
      `)
      .bind(
        billId
      )
      .all();


  const totalsByItem = {};


  for (
    const row
    of existingResult.results ||
    []
  ) {
    if (
      String(
        row.person_id
      ) ===
      personId
    ) {
      continue;
    }

    const itemId =
      String(
        row.item_id
      );

    totalsByItem[
      itemId
    ] =
      roundMoney(
        (
          totalsByItem[
            itemId
          ] || 0
        ) +
        Number(
          row.share_amount ||
          0
        )
      );
  }


  for (
    const selection
    of normalized
  ) {
    const item =
      itemById.get(
        selection.itemId
      );

    const alreadyAssigned =
      totalsByItem[
        selection.itemId
      ] || 0;

    const proposedTotal =
      roundMoney(
        alreadyAssigned +
        selection.shareAmount
      );


    if (
      proposedTotal >
      roundMoney(
        item.lineTotal
      ) +
      0.01
    ) {
      throw new Error(
        "That item no longer has enough unclaimed amount. Reload and try again."
      );
    }
  }


  await env.DB
    .prepare(`
      DELETE FROM selections
      WHERE bill_id = ?
        AND person_id = ?
    `)
    .bind(
      billId,
      personId
    )
    .run();


  if (
    normalized.length
  ) {
    const statements =
      normalized.map(
        selection =>
          env.DB
            .prepare(`
              INSERT INTO selections (
                selection_id,
                bill_id,
                person_id,
                item_id,
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
              personId,
              selection.itemId,
              selection.shareAmount
            )
      );


    await env.DB.batch(
      statements
    );
  }


  return getAppState(env);
}


// ============================================================
// PERSON COLOR
// ============================================================

async function updatePersonColor(
  env,
  request
) {
  const billId =
    String(
      request.billId || ""
    ).trim();

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
    !billId ||
    !personId
  ) {
    throw new Error(
      "Bill and participant are required."
    );
  }


  if (
    !PERSON_COLOR_KEYS.includes(
      color
    )
  ) {
    throw new Error(
      "Invalid color."
    );
  }


  const bill =
    await env.DB
      .prepare(`
        SELECT
          bill_id,
          status
        FROM bills
        WHERE bill_id = ?
        LIMIT 1
      `)
      .bind(
        billId
      )
      .first();


  if (
    !bill ||
    bill.status !== "active"
  ) {
    throw new Error(
      "This bill is no longer active."
    );
  }


  const person =
    await env.DB
      .prepare(`
        SELECT
          person_id
        FROM people
        WHERE bill_id = ?
          AND person_id = ?
        LIMIT 1
      `)
      .bind(
        billId,
        personId
      )
      .first();


  if (!person) {
    throw new Error(
      "Participant not found."
    );
  }


  const used =
    await env.DB
      .prepare(`
        SELECT
          person_id
        FROM people
        WHERE bill_id = ?
          AND color = ?
          AND person_id <> ?
        LIMIT 1
      `)
      .bind(
        billId,
        color,
        personId
      )
      .first();


  if (used) {
    throw new Error(
      "That color is already being used."
    );
  }


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


  return getAppState(env);
}


// ============================================================
// ARCHIVE
// ============================================================

async function archiveActiveBill(
  env
) {
  await env.DB
    .prepare(`
      UPDATE bills
      SET
        status = 'archived',
        updated_at =
          CURRENT_TIMESTAMP
      WHERE status = 'active'
    `)
    .run();
}


async function getBillHistory(env) {
  const result =
    await env.DB
      .prepare(`
        SELECT
          bill_id,
          title,
          restaurant_name,
          receipt_date,
          grand_total,
          status,
          created_at,
          updated_at
        FROM bills
        WHERE status = 'archived'
        ORDER BY updated_at DESC
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
          row.title || ""
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

      grandTotal:
        Number(
          row.grand_total ||
          0
        ),

      status:
        String(
          row.status || ""
        ),

      createdAt:
        row.created_at || "",

      updatedAt:
        row.updated_at || ""
    })
  );
}


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
      "Bill not found."
    );
  }


  return buildBillState(
    env,
    bill
  );
}


async function restoreBill(
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
      "Bill not found."
    );
  }


  const statements = [
    env.DB
      .prepare(`
        UPDATE bills
        SET
          status = 'archived',
          updated_at =
            CURRENT_TIMESTAMP
        WHERE status = 'active'
      `),

    env.DB
      .prepare(`
        UPDATE bills
        SET
          status = 'active',
          updated_at =
            CURRENT_TIMESTAMP
        WHERE bill_id = ?
      `)
      .bind(
        billId
      )
  ];


  await env.DB.batch(
    statements
  );


  return getAppState(env);
}


async function deleteArchivedBill(
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
      "Bill not found."
    );
  }


  if (
    bill.status === "active"
  ) {
    throw new Error(
      "Archive the bill before deleting it."
    );
  }


  await env.DB
    .prepare(`
      DELETE FROM bills
      WHERE bill_id = ?
    `)
    .bind(
      billId
    )
    .run();
}


// ============================================================
// GEMINI RECEIPT IMAGE ANALYSIS
// ============================================================

async function analyzeReceiptImageWithGemini(
  env,
  mimeType,
  imageBase64
) {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY secret is not configured."
    );
  }


  if (!imageBase64) {
    throw new Error(
      "Receipt image is required."
    );
  }


  const cleanMimeType =
    String(
      mimeType ||
      "image/jpeg"
    )
      .split(";")[0]
      .trim();


  const prompt = `
You are analyzing a restaurant or store receipt image.

Return ONLY valid JSON.

Use this exact structure:

{
  "storeName": "",
  "address": "",
  "date": "",
  "time": "",
  "subtotal": 0,
  "tax": 0,
  "tip": 0,
  "grandTotal": 0,
  "items": [
    {
      "name": "",
      "quantity": null,
      "unitPrice": null,
      "lineTotal": 0
    }
  ]
}

Rules:

1. Extract only actual purchased line items.
2. Do not include subtotal, tax, tip, total, balance, payment, change, card information, discounts, or headers as items.
3. Preserve item names as closely as practical while cleaning obvious OCR noise.
4. quantity should be a number when the receipt clearly indicates multiple units; otherwise null.
5. unitPrice should be a number only when clearly shown or safely derivable.
6. lineTotal must be the total charged for that item line.
7. All money values must be plain numbers without currency symbols.
8. If tip is blank, missing, handwritten but unreadable, or not clearly present, use 0.
9. If subtotal/tax/total are clearly printed, prefer the printed values.
10. If an item line has modifiers or continuation text, combine it into a useful item name when appropriate.
11. Do not invent items or amounts.
12. date should preferably be YYYY-MM-DD when the receipt provides enough information.
13. time should preferably be HH:MM when readable.
`.trim();


  const data =
    await callGemini(
      env,
      {
        contents: [
          {
            parts: [
              {
                text:
                  prompt
              },
              {
                inline_data: {
                  mime_type:
                    cleanMimeType,
                  data:
                    imageBase64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature:
            0.1,
          responseMimeType:
            "application/json"
        }
      }
    );


  return normalizeGeminiReceipt(
    extractGeminiJson(
      data
    )
  );
}


// ============================================================
// GEMINI OCR TEXT ANALYSIS
// ============================================================

async function analyzeReceiptTextWithGemini(
  env,
  ocrText
) {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY secret is not configured."
    );
  }


  if (!ocrText.trim()) {
    throw new Error(
      "OCR text is required."
    );
  }


  const prompt = `
You are given OCR text from a restaurant or store receipt.

Return ONLY valid JSON.

Use this exact structure:

{
  "storeName": "",
  "address": "",
  "date": "",
  "time": "",
  "subtotal": 0,
  "tax": 0,
  "tip": 0,
  "grandTotal": 0,
  "items": [
    {
      "name": "",
      "quantity": null,
      "unitPrice": null,
      "lineTotal": 0
    }
  ]
}

Rules:

1. Extract only actual purchased line items.
2. Do not include subtotal, tax, tip, total, balance, payment, change, card information, discounts, or headers as items.
3. Clean obvious OCR noise from item names.
4. quantity should be a number when clearly indicated; otherwise null.
5. unitPrice should be a number only when clearly shown or safely derivable.
6. lineTotal must be the total charged for the item line.
7. All money values must be plain numbers.
8. If tip is missing or unclear, use 0.
9. Prefer printed subtotal/tax/total values from the OCR when clearly available.
10. Do not invent missing purchases or amounts.

OCR TEXT:
${ocrText}
`.trim();


  const data =
    await callGemini(
      env,
      {
        contents: [
          {
            parts: [
              {
                text:
                  prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature:
            0.1,
          responseMimeType:
            "application/json"
        }
      }
    );


  return normalizeGeminiReceipt(
    extractGeminiJson(
      data
    )
  );
}


// ============================================================
// GEMINI API
// ============================================================

async function callGemini(
  env,
  payload
) {
  const response =
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );


  const text =
    await response.text();


  let data;


  try {
    data =
      JSON.parse(
        text
      );
  } catch {
    throw new Error(
      "Gemini returned an invalid response."
    );
  }


  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Gemini request failed (${response.status}).`;

    throw new Error(
      message
    );
  }


  return data;
}


function extractGeminiJson(
  data
) {
  const text =
    data
      ?.candidates?.[0]
      ?.content
      ?.parts
      ?.map(
        part =>
          part.text || ""
      )
      .join("")
      .trim();


  if (!text) {
    throw new Error(
      "Gemini returned no receipt data."
    );
  }


  let cleaned =
    text.trim();


  cleaned =
    cleaned.replace(
      /^```(?:json)?\s*/i,
      ""
    );

  cleaned =
    cleaned.replace(
      /\s*```$/,
      ""
    );


  try {
    return JSON.parse(
      cleaned
    );
  } catch {
    const firstBrace =
      cleaned.indexOf(
        "{"
      );

    const lastBrace =
      cleaned.lastIndexOf(
        "}"
      );


    if (
      firstBrace >= 0 &&
      lastBrace >
      firstBrace
    ) {
      return JSON.parse(
        cleaned.slice(
          firstBrace,
          lastBrace + 1
        )
      );
    }


    throw new Error(
      "Gemini returned receipt data that could not be parsed."
    );
  }
}


function normalizeGeminiReceipt(
  receipt
) {
  const items =
    Array.isArray(
      receipt?.items
    )
      ? receipt.items
          .map(
            item => {
              const name =
                String(
                  item?.name ||
                  ""
                ).trim();

              const lineTotal =
                Number(
                  item?.lineTotal
                );


              if (
                !name ||
                !Number.isFinite(
                  lineTotal
                )
              ) {
                return null;
              }


              return {
                name,

                quantity:
                  numberOrNull(
                    item?.quantity
                  ),

                unitPrice:
                  numberOrNull(
                    item?.unitPrice
                  ),

                lineTotal:
                  roundMoney(
                    lineTotal
                  )
              };
            }
          )
          .filter(Boolean)
      : [];


  return {
    storeName:
      String(
        receipt?.storeName ||
        ""
      ).trim(),

    address:
      String(
        receipt?.address ||
        ""
      ).trim(),

    date:
      String(
        receipt?.date ||
        ""
      ).trim(),

    time:
      String(
        receipt?.time ||
        ""
      ).trim(),

    subtotal:
      safeMoney(
        receipt?.subtotal
      ),

    tax:
      safeMoney(
        receipt?.tax
      ),

    tip:
      safeMoney(
        receipt?.tip
      ),

    grandTotal:
      safeMoney(
        receipt?.grandTotal
      ),

    items
  };
}
