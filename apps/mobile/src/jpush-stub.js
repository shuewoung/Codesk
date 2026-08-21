module.exports = {
  init() {},
  getRegistrationID(cb) {
    if (typeof cb === 'function') cb({ registerID: '' });
  },
  addNotificationListener() {},
  getLaunchAppNotification(cb) {
    if (typeof cb === 'function') cb({});
  },
};
