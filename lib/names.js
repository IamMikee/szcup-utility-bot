function normalizeName(name) {
  return String(name).toLowerCase().trim().split(/\s+/).join(' ');
}

module.exports = { normalizeName };
