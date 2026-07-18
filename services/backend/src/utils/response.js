/**
 * Standardized API response helpers
 */

function ok(res, data = null, message = 'Success') {
  return res.json({
    success: true,
    message,
    data
  });
}

function fail(res, message = 'Request failed', status = 400, errors = null) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(status).json(body);
}

function page(res, rows, total, pageNum, pageSize) {
  return res.json({
    success: true,
    data: {
      list: rows,
      total,
      page: parseInt(pageNum),
      pageSize: parseInt(pageSize)
    }
  });
}

module.exports = { ok, fail, page };
