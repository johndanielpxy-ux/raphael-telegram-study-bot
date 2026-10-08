import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { importSql } from '../src/content.ts';

const args=process.argv.slice(2), file=args[0], outIndex=args.indexOf('--out');
try {
  if (!file) throw new Error('Usage: npm run import:cards -- cards/file.json [--out exports/cards.generated.sql]');
  const sql=importSql(JSON.parse(await readFile(file,'utf8')));
  if (outIndex>=0) {
    const output=args[outIndex+1];
    if (!output) throw new Error('--out needs a filename');
    await mkdir(dirname(output),{recursive:true});
    await writeFile(output,sql+'\n',{flag:'wx'});
    console.log(`Validated import saved to ${output}. Scheduling is preserved on reimport.`);
  } else { process.stdout.write(sql+'\n'); }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Import failed'); process.exitCode=1;
}
