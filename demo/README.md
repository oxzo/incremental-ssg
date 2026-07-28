# The public demo

A live site that a CMS edit visibly rebuilds. The point is not that a static site
generator can produce HTML — it is that **an editor saves in Directus and the
public site changes seconds later, having uploaded only the files that actually
differ.**

```
Directus (podman, local)  --flow webhook-->  cli serve (local)
                                                  |
                                           sync -> build -> deploy diff
                                                  |
                                            R2 bucket (Cloudflare)
                                                  |
                                      Worker on *.workers.dev  -->  public
```

## What is where, and why

**The site is always up; the ability to change it is not.** R2 serves the built
site whether or not the machine that built it is awake. Directus and the publish
service run locally and only need to be running while someone is demonstrating an
edit. This is a deliberate split, not a limitation worked around: the artefact is
permanent and the editing rig is not.

**No tunnel is needed for the mechanics.** Directus and the service are both
local, so the webhook is localhost to localhost. `cloudflared` is only useful if
an audience wants to watch the Directus UI, and is otherwise unnecessary.

**No adapter code is demo-specific.** `cli serve --to s3://<bucket>` targets R2
through the same `s3DeployTarget` that targets MinIO in `stack/`, because R2
speaks the S3 API. The only thing that changes is environment.

## One-time setup

1. **R2 bucket + token.** In the Cloudflare dashboard: create a bucket, then an
   R2 API token with Object Read & Write scoped to it. Note the
   `https://<account-id>.r2.cloudflarestorage.com` endpoint.
2. **Credentials.** `cp stack/env.r2.sh.example stack/env.r2.sh` and fill it in.
   That path is gitignored; `stack/env.sh` is committed because it holds only
   throwaway fixtures.
3. **Worker.** Set `bucket_name` in `demo/worker/wrangler.toml` to match, then
   `npm i && npx wrangler deploy` from `demo/worker/`. Deploying prints the
   `*.workers.dev` URL.

## Running it

```sh
source stack/env.sh && source stack/env.r2.sh
stack/up.sh && node --no-warnings stack/seed.ts 2000

DIRECTUS_COLLECTIONS="post,author,tag,page,settings" \
DIRECTUS_EMAIL="$ISSG_DIRECTUS_EMAIL" DIRECTUS_PASSWORD="$ISSG_DIRECTUS_PASSWORD" \
WEBHOOK_SECRET="$ISSG_HOOK_TOKEN" \
node --no-warnings src/cli.ts serve \
  --site example/blog/site.ts \
  --db .tmp/demo/content.db --out .tmp/demo/dist \
  --cms "directus+$ISSG_DIRECTUS_URL" \
  --to "s3://$ISSG_DEMO_BUCKET" \
  --host 0.0.0.0 --port 8787 --path /hooks/cms \
  --build-on-start
```

The first run uploads the whole tree. Then edit a post title at
`http://127.0.0.1:8055`, and watch:

```
webhook.accepted   route=/hooks/cms  expectations=["post-1043"]
run.published      source=webhook  uploaded=8  unchanged=2314
```

## Choosing which post to edit

**Edit an old post for a clean demo — expect single digits.** Editing one of the
*newest* posts in a tag publishes hundreds of files, and that is correct rather
than broken: this site puts a related-posts sidebar on every post, drawn from the
newest entries of each tag, so those few posts genuinely appear on a third of the
site. The distribution is measured in `bench/run-fanout-templates.ts` — median 8
routes, maximum 835 at 2,000 posts.

Both are worth showing. The small number is the deploy diff earning its keep; the
large one is why fan-out is a property of the template set rather than of the
content model.

## Caching, and why there is deliberately none

Asset derivatives are content-addressed, so their URLs change when their bytes do
and they carry a one-year `immutable`. HTML routes keep their URLs across edits,
so the Worker serves them `max-age=0, must-revalidate` and holds nothing at the
edge.

That is a choice with a consequence worth stating: because nothing is cached,
there is nothing to invalidate, which is why `s3DeployTarget` still reports
`pathPurge: false` honestly. Putting a real edge cache in front of this is what
would make implementing `purge()` meaningful — and it is the next thing that
would make the demo more, not less, honest.

## Costs

Free, with room to spare. R2's free tier is 10 GB of storage, 1 million Class A
operations a month and **no egress charge**; a full 2,300-file deploy is ~2,300
Class A operations, and an ordinary edit is single digits. The Workers free plan
is 100,000 requests a day at 10 ms CPU each, and serving a file from a bucket
binding is nowhere near that ceiling.

`workers.dev` is documented as being for personal and hobby projects rather than
production. That is the right size for this, and a custom domain is the escape
hatch if it ever is not.
