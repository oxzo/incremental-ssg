// Open a store read-write once, so its migrations run.
//
// Index changes land through the normal read-write path, which in a real flow
// means "on the next sync". A benchmark corpus is synced once and then read
// forever, so without this it would keep measuring the old schema and quietly
// report that an optimisation did nothing.
import { DocumentStore } from '../src/store.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: node bench/migrate-db.ts <db>')
  process.exit(2)
}
const store = new DocumentStore(path)
try {
  const indexes = (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='documents'")
    .all() as { name: string }[]
  console.log(`${path}: ${indexes.map((i) => i.name).join(', ')}`)
} finally {
  store.close()
}
