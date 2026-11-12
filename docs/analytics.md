# Usage analytics (Umami)

WoundQuant can report **anonymous usage statistics** to [Umami](https://umami.is),
so you can see how the tool is really used: how many images people load per
session, which engine and settings they choose, how often they correct masks by
hand, what they export, and where errors happen.

It is **switched off until you fill in a website ID**. With an empty ID nothing
is loaded and nothing leaves the browser.

## Switching it on

1. Create a website in Umami — either [Umami Cloud](https://cloud.umami.is)
   (free tier) or your own server. Use the domain the app is served from, e.g.
   `baobabprince.github.io`.
2. Copy the **Website ID** (Settings → Websites → Edit).
3. Edit `config.js` in the repository root:

   ```js
   window.WOUNDQUANT_CONFIG = {
     analytics: {
       websiteId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
       scriptUrl: 'https://cloud.umami.is/script.js', // self-hosted: https://<your-host>/script.js
       domains: ['baobabprince.github.io'],            // only these hosts are counted
       respectDoNotTrack: true,
     },
   };
   ```

4. Commit and publish. No build step.

`domains` keeps local runs, forks and previews out of your statistics; an empty
list counts every host. If the site moves to another domain, update the list.

To check without sending anything, open the app with `?analytics=debug`: every
event is printed to the browser console (marked `(not sent)` while analytics is
inactive) and kept in `window.__wqAnalyticsLog`.

## What is sent

Umami records a page view (URL without query string, referrer, browser, OS,
device type, country) and the custom events below. It sets **no cookies** and
stores no personal identifier.

| Event | Data | Answers |
|---|---|---|
| `app_ready` | `version`, `lang`, `cores`, `workers`, `supported`, `models` | Which browsers / machines? Hebrew or English? |
| `files_added` | `method` (picker, folder, drop, drop_folder, examples), `images`, `total`, `series`, `tiff`, `unparsed` | How large are real batches? Do file names follow the expected pattern? |
| `analysis_started` | `images`, `series`, `engine`, `workers` | |
| `analysis_finished` | `images`, `computed`, `cached`, `errors`, `flagged`, `seconds`, `ms_per_image`, `engine` | How long do users wait? How many images get a quality warning? |
| `analysis_paused` / `analysis_resumed` / `analysis_cancelled` | `done`, `total` (cancel) | Are batches abandoned? |
| `engine_changed` | `engine` (classical, bundled_model, custom_model) | Is the neural engine used? |
| `model_uploaded` | `size_kb` | Do users train their own models? |
| `param_changed` | `param`, `value` | Which defaults are wrong? |
| `params_reset`, `advanced_opened`, `pixel_size_set` | `set` | |
| `mask_edited` | `tool` (brush, eraser, polygon, undo) — once per image | How often is the automatic result not good enough? |
| `mask_reset` | | |
| `export` | `kind` (csv, summary_csv, training_zip, overlay_png), `rows` / `samples`, `manual` | What do users take away? |
| `filter_flagged`, `chart_all_series` | `on` | |
| `area_chart_mode` | `mode` (t0, abs, well) | Which view of the wound area do users prefer? |
| `language_changed` | `lang` | |
| `error` | `where`, `count`, `kind` (short error code) | Where does it break? |
| `session_summary` | `series_opened`, `edits`, `minutes` — once, when the tab is hidden | How much review work per visit? |
| `analytics_opt_out` | | |

**Never sent:** images, pixels, masks, measurements, file names, folder names,
plate or well names. `js/analytics.js` enforces this technically: event data may
only contain numbers, booleans and strings of at most 100 characters, and the
callers only pass counts and option names. An end-to-end test checks that no
file name appears in any event.

## Visitors' choices

* The footer says that statistics are collected and has a **switch-off button**.
  It sets `localStorage["umami.disabled"]`, the switch Umami's own tracker
  honours, so it also holds if the script is loaded some other way.
* The browser's **Do Not Track** setting is honoured (`respectDoNotTrack`).
* Ad blockers that block Umami simply make `track()` a no-op; the app works the same.

## Useful reports in Umami

* **Events → `files_added` → property `total`**: distribution of batch sizes.
* **Events → `analysis_finished` → `ms_per_image`** by browser: real performance.
* **Funnel**: page view → `files_added` → `analysis_finished` → `export`.
* Ratio of `mask_edited` to images analysed: how much the automatic result is trusted.
* `error` by `where`/`kind`: what to fix first.
