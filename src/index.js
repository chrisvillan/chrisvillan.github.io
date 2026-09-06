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

    return env.ASSETS.fetch(request);
  }
};
