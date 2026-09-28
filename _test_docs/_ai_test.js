
const fs = require('fs');
async function test() {
  const { recognizeImage, extractWithAI } = require('/app/dist/services/ocrParser');
  const text = await recognizeImage('/app/_test_docs/invoice.jpg');
  console.log('OCR text len:', text.length);
  
  try {
    const result = await extractWithAI(text, 'invoice');
    console.log('AI result:', JSON.stringify(result, null, 2));
  } catch(e) {
    console.log('AI error:', e.message);
    fs.writeFileSync('/tmp/ai_error.txt', e.message + '\n' + e.stack);
  }
}
test();
