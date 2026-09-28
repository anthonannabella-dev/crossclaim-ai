
try {
  require('@alicloud/ocr-api20210707');
  console.log('SDK已存在');
} catch(e) {
  console.log('SDK缺失:', e.message);
}
