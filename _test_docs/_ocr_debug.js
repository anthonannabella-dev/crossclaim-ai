
const { recognizeImage } = require('/app/dist/services/ocrParser');
const fs = require('fs');
recognizeImage('/app/_test_docs/invoice.jpg').then(r => {
  fs.writeFileSync('/tmp/ocr_debug.txt', JSON.stringify({len: (r||'').length, txt: (r||'').slice(0,500)}));
  console.log('DONE');
}).catch(e => {
  fs.writeFileSync('/tmp/ocr_debug.txt', 'ERR: ' + e.message);
  console.log('ERR');
});
