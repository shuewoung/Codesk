module.exports = {
  init() {},
  getRegistrationID(cb) {
    if (typeof cb === 'function') cb({ registerID: '' });
  },
};
