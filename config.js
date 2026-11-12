// WoundQuant site configuration — edit this file, no build step needed.
window.WOUNDQUANT_CONFIG = {
  analytics: {
    // Anonymous usage statistics with Umami (https://umami.is).
    // Paste the "Website ID" from your Umami dashboard to switch tracking on;
    // leave it empty and nothing is loaded or sent. See docs/analytics.md.
    websiteId: '',

    // Tracker script: Umami Cloud by default; for a self-hosted Umami use
    // 'https://<your-umami-host>/script.js'.
    scriptUrl: 'https://cloud.umami.is/script.js',

    // Only count visits on these host names (keeps localhost and forks out of
    // the statistics). Empty list = count everywhere the site is served.
    domains: ['baobabprince.github.io'],

    // Honour the browser's "Do Not Track" setting.
    respectDoNotTrack: true,
  },
};
