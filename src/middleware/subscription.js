const logger = require('../lib/logger');
const { getTenantContext } = require('../config/db');
const { assertCanCreateTransaction } = require('../lib/subscription');

function requireTransactionQuota() {
  return async (req, res, next) => {
    try {
      const ctx = getTenantContext();
      await assertCanCreateTransaction(null, ctx.idtenant);
      next();
    } catch (err) {
      logger.error(err, { req });
      res.status(err.statusCode || 500).json({
        message: err.message,
        code: err.code,
        details: err.details,
      });
    }
  };
}

module.exports = {
  requireTransactionQuota,
};
