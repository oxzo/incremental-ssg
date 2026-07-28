// Runs a real sync against a mock CMS and dies mid-write.
//
// Spawned by test/sync.test.ts. A separate process rather than a thrown error
// because the property under test is what survives in *SQLite* when the writer
// stops existing -- no finally block, no close(), no flush. Throwing inside sync
// would unwind through code paths a crash never reaches, and would test the
// unwinding rather than the durability.
//
// The kill point is chosen by the parent, not by this script: the mock CMS
// serves page one and then hangs on the request for page two, and the parent
// SIGKILLs this process while it waits. That boundary is the interesting one and
// it is race-free in the direction that matters -- sync commits each page before
// it asks for the next, so "page two was requested" *proves* page one is
// committed. Nothing here has to guess how long a commit takes.
import { httpCmsAdapter } from '../src/cms.ts'
import { DocumentStore } from '../src/store.ts'
import { sync } from '../src/sync.ts'

const [url, dbPath, pageSize] = process.argv.slice(2)

const store = new DocumentStore(dbPath)
const adapter = httpCmsAdapter({ baseUrl: url })

// Announce readiness only after the store is open, so the parent's kill cannot
// land before there is anything to interrupt.
process.stdout.write('ready\n')

await sync(adapter, store, { pageSize: Number(pageSize), reconcile: false })

// Only reached if the parent never killed us, which means the test's kill point
// did not fire. Reported rather than exited quietly, so that shows up as a
// failed assertion instead of a mysteriously passing test.
store.close()
process.stdout.write('completed\n')
