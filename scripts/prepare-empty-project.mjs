// Produce one atomic SQL bundle for a new, empty Supabase test project only.
// Never reads credentials or changes a remote project itself.
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function emptyProjectSql() {
  const directory=new URL('../supabase/migrations/',import.meta.url);
  const names=(await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
  const quote=value=>`'${value.replaceAll("'","''")}'`;
  const versions=names.map(name=>name.split('_')[0]);
  const sections=await Promise.all(names.map(async name=>{
    const version=name.split('_')[0],label=name.slice(version.length+1,-4);
    return `${await readFile(new URL(name,directory),'utf8')}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values(${quote(version)},${quote(label)},array[]::text[]);`;
  }));
  return `-- GongZhu EMPTY TEST PROJECT ONLY; ${names.length} migrations.\n-- An existing or partially installed database is refused, without changes.\nbegin;\ncreate schema if not exists supabase_migrations;\ncreate table if not exists supabase_migrations.schema_migrations(version text primary key,statements text[],name text);\ndo $guard$ begin\n if exists(select 1 from information_schema.tables where table_schema='public' and table_type='BASE TABLE') or exists(select 1 from supabase_migrations.schema_migrations) then\n  raise exception 'Refusing bootstrap: database is not empty. Use incremental migrations instead.';\n end if;\nend $guard$;\n${sections.join('\n\n')}\ncommit;\nselect count(*) as installed_migrations from supabase_migrations.schema_migrations where version in (${versions.map(quote).join(',')});\n`;
}
if(process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  const target=process.argv[2];if(!target)throw new Error('Usage: node scripts/prepare-empty-project.mjs /absolute/path/empty-project.sql');
  await writeFile(target,await emptyProjectSql(),'utf8');console.log(`Empty-project SQL saved: ${target}`);
}
