const app = require('./app.json');

module.exports = () => {
  const expo = { ...app.expo, plugins: [...(app.expo.plugins || [])] };
  expo.owner = 'cheungsws-team';
  return { expo };
};
