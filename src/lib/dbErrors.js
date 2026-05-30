function isForeignKeyConstraintError(err) {
  return err?.code === 'ER_ROW_IS_REFERENCED'
    || err?.code === 'ER_ROW_IS_REFERENCED_2'
    || err?.errno === 1451;
}

module.exports = {
  isForeignKeyConstraintError,
};
