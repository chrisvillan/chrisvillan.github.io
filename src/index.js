const PERSON_COLOR_KEYS = [
  "blue",
  "purple",
  "rose",
  "orange",
  "emerald",
  "cyan",
  "amber",
  "lime",
  "red",
  "brown",
  "pink",
  "violet",
  "indigo",
  "green",
  "yellow",
  "sky",
  "mint",
  "coral",
  "slate",
  "gray"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Keep our simple D1 test endpoint.
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

    // New bill-app API.
    if (url.pathname === "/api") {
      if (request.method !== "POST") {
        return json({
          ok: false,
          error: "POST requests only."
        }, 405);
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
            }, 400);
        }
      } catch (error) {
        console.error(error);

        return json({
          ok: false,
          error: error?.message || String(error)
        }, 500);
      }
    }

    // Everything else is your normal website.
    return env.ASSETS.fetch(request);
  }
};


// ------------------------------------------------------------
// APP STATE
// ------------------------------------------------------------

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

  const people = (peopleResult.results || []).map((row, index) => {
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
  });

  const items = (itemsResult.results || []).map(row => ({
    itemId: String(row.item_id),
    name: String(row.name || ""),
    quantity: numberOrNull(row.quantity),
    unitPrice: numberOrNull(row.unit_price),
    lineTotal: Number(row.line_total || 0)
  }));

  const selections = (selectionsResult.results || []).map(row => ({
    personId: String(row.person_id),
    itemId: String(row.item_id),
    shareAmount: Number(row.share_amount || 0)
  }));

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

      // Keep the same values your old frontend expects.
      status: bill.status === "active"
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


// ------------------------------------------------------------
// PARTICIPANT SELECTIONS
// ------------------------------------------------------------

async function saveParticipantSelection(env, request) {
  const state = await getAppState(env);

  if (!state.hasActiveBill) {
    throw new Error("There is no active bill.");
  }

  const billId = state.bill.billId;
  const personId = String(request.personId || "").trim();

  const personExists = state.people.some(
    person => person.personId === personId
  );

  if (!personExists) {
    throw new Error("The selected person was not found.");
  }

  const submitted = Array.isArray(request.selections)
    ? request.selections
    : [];

  const submittedMap = {};

  for (const selection of submitted) {
    const itemId = String(selection.itemId || "");
    const amount = roundMoney(
      Number(selection.shareAmount || 0)
    );

    if (amount < 0) {
      throw new Error("Item shares cannot be negative.");
    }

    submittedMap[itemId] = amount;
  }

  // Validate that this person isn't trying to claim more
  // than what remains after everyone else's selections.
  for (const item of state.items) {
    const otherPeopleAssigned = state.selections
      .filter(selection =>
        selection.itemId === item.itemId &&
        selection.personId !== personId
      )
      .reduce(
        (sum, selection) =>
          sum + Number(selection.shareAmount || 0),
        0
      );

    const requestedAmount =
      submittedMap[item.itemId] || 0;

    if (
      otherPeopleAssigned + requestedAmount >
      Number(item.lineTotal) + 0.01
    ) {
      const remaining = Math.max(
        0,
        Number(item.lineTotal) - otherPeopleAssigned
      );

      throw new Error(
        item.name +
        " only has " +
        formatMoneyForError(remaining) +
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
      .bind(billId, personId)
  ];

  for (const item of state.items) {
    const amount = submittedMap[item.itemId] || 0;

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
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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

  await env.DB.batch(statements);

  return getAppState(env);
}


// ------------------------------------------------------------
// PERSON COLORS
// ------------------------------------------------------------

async function updatePersonColor(env, request) {
  const state = await getAppState(env);

  if (!state.hasActiveBill) {
    throw new Error("There is no active bill.");
  }

  const billId = state.bill.billId;
  const personId = String(request.personId || "").trim();
  const color = String(request.color || "")
    .trim()
    .toLowerCase();

  if (!PERSON_COLOR_KEYS.includes(color)) {
    throw new Error("Choose one of the available colors.");
  }

  const person = state.people.find(
    candidate => candidate.personId === personId
  );

  if (!person) {
    throw new Error("The selected person was not found.");
  }

  const claimedByOther = state.people.some(
    candidate =>
      candidate.personId !== personId &&
      candidate.color === color
  );

  if (claimedByOther) {
    throw new Error("That color has already been claimed.");
  }

  const result = await env.DB
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


// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
}


function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function roundMoney(value) {
  return Math.round(
    (Number(value || 0) + Number.EPSILON) * 100
  ) / 100;
}


function formatMoneyForError(value) {
  return "$" + Number(value || 0).toFixed(2);
}
