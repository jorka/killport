const path = require('node:path');
// mocha 11: mocha 12 is ES-module only and needs Node 20.19+, but VS Code 1.90 (our minimum) ships Node 20.9.
const Mocha = require('mocha');

exports.run = () =>
  new Promise((resolve, reject) => {
    const mocha = new Mocha({ ui: 'bdd', timeout: 30000, color: true });
    mocha.addFile(path.join(__dirname, 'extension.test.js'));
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
