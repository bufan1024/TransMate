function pdf(objects) {
  const buffers = [Buffer.from('%PDF-1.4\n')];
  let offset = buffers[0].length;
  const locations = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    locations.push(String(offset).padStart(10, '0') + ' 00000 n \n');
    const buffer = Buffer.from((index + 1) + ' 0 obj\n' + object + '\nendobj\n', 'latin1');
    buffers.push(buffer);
    offset += buffer.length;
  }
  buffers.push(Buffer.from('xref\n0 ' + locations.length + '\n' + locations.join('')
    + 'trailer\n<< /Size ' + locations.length + ' /Root 1 0 R >>\nstartxref\n' + offset + '\n%%EOF\n'));
  return Buffer.concat(buffers);
}

function stream(contents, fields = '') {
  return '<< /Length ' + Buffer.byteLength(contents, 'latin1') + ' ' + fields + ' >>\nstream\n'
    + contents + '\nendstream';
}

export const pdfSnippet = 'Selected PDF snippet';

export const textualPdf = pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
  stream('BT /F1 18 Tf 72 700 Td (Private first page) Tj ET'),
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
  stream('BT /F1 18 Tf 72 700 Td (' + pdfSnippet + ') Tj 0 -30 Td (Private second page) Tj ET'),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]);

const pixels = Array.from({ length: 64 }, (_, index) => String.fromCharCode((index + Math.floor(index / 8)) % 2 ? 240 : 10)).join('');
export const scannedPdf = pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
  stream('q 160 0 0 160 72 490 cm /Im0 Do Q'),
  stream(pixels, '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8'),
]);
