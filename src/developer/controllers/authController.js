const devAuth = require('../middleware/devAuth');
const logger = require('../../lib/logger');

exports.loginPage = (req, res) => {
  if (req.session && req.session.devAuthenticated) {
    return res.redirect('/developer');
  }
  res.render('login', { error: null, layout: false, title: 'Login', active: '' });
};

exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (devAuth.validateLogin(username, password)) {
    req.session.devAuthenticated = true;
    req.session.devLoginTime = new Date();

    await logger.history('DEV_LOGIN', {
      iduser: 0,
      ref: `dev_${username}`,
      detail: { username },
      req
    });

    return res.redirect('/developer');
  }

  res.render('login', {
    error: 'Username atau password salah',
    layout: false,
    title: 'Login',
    active: ''
  });
};

exports.logout = (req, res) => {
  req.session.destroy(() => {
    res.redirect('/developer/login');
  });
};
