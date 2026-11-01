# Lessons

What fixed each kind of failure, so the same problem isn't solved twice. The queue's
failure history (`server/runs/batches/FAILURES.md`, or **Queue › Failure history** in the
app) prints the matching section under each failure. One section per kind, named as the
history names it: `check:<critic check>`, `lint:<kind>` or `error`. Write what changed
and the batch that proved it.

## check:whole_subject

The product came cut, by the slide or by its own photo. The lint measures the subject
box from SAM against the photo area and rejects the round before the critic sees it; the
analyst marks studio shots whose product touches the file's edge (`cropped`) so the
director doesn't use them; the cover puts the text above and the whole photo below.

## lint:subject cut by the edge

Same cause as `check:whole_subject`: the photo frame narrows to the subject instead of
filling with blur (`window` composition), and a cropped studio shot is never planned.

## check:system

Slides didn't look like one family (a pink CTA from "accent slides", a hero with a ghost
word among photo bands). Fixed cards, the eyebrow on every slide or none, one skeleton
for the middle slides (`fixLayouts`), and slide 2 built first as the master the critic
compares the rest with.

## check:brand

The designer typed the business name instead of placing the logo. The templates place
the logo themselves; a solid-shape logo (`badge`) goes without a plate.

## check:aesthetic

The retoucher moved layers by hand and the last round, often the worst, was kept. Now the
fixer only picks template settings (`Tweaks`), the slide is rebuilt and the best round
is kept.

## error

Sites that gave no usable images: Wix and Magento serve thumbnails (`fullSize` asks for
the original), Nuxt/React sites need Edge to wait for the JavaScript, and when the HTML
has nothing, Muse Spark finds the images in the screenshot (`screen_assets.ts`).
