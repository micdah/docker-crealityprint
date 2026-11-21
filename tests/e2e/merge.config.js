// Config for `playwright merge-reports` (CI report job): merges the per-spec blob reports into
// one HTML report. An explicit output folder is required: the blobs record the runner
// container's paths (/e2e/tests), which don't exist where the merge runs.
const path = require('node:path');

module.exports = {
  testDir: __dirname,
  reporter: [
    [
      'html',
      {
        outputFolder: process.env.E2E_MERGED_REPORT_DIR || path.join(__dirname, 'merged-report'),
        open: 'never',
      },
    ],
  ],
};
