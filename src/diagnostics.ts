export function deliveryDiagnostic(error:unknown):string {
  if (!(error instanceof Error)) return 'unexpected_error';
  const http=/^Telegram [A-Za-z]+ failed \((\d{3})\)$/.exec(error.message);
  if (http) return `telegram_http_${http[1]}`;
  if (error.message==='Telegram network request failed') return 'telegram_network';
  return `unexpected_${['TypeError','RangeError','SyntaxError'].includes(error.name)?error.name:'Error'}`;
}
