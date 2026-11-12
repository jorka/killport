const path = require('node:path');
const Mocha = require('mocha');

exports.run = () =>
  new Promise((resolve, reject) => {
    const mocha = new Mocha({ ui: 'bdd', timeout: 30000, color: true });
    mocha.addFile(path.join(__dirname, 'extension.test.js'));
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
