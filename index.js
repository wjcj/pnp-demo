var qs = require('qs');

var obj = { a: 1, b: 2 };
var str = qs.stringify(obj);

console.log('index.js ====>', str);
// yarn node index.js
// node -r ./.pnp.js ./index.js
// NODE_OPTIONS="--require $(pwd)/.pnp.js" node ./index.js