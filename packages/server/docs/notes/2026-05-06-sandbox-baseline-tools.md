# Sandbox Baseline Tools

The sandbox image now bakes in `jq`, `git`, Python 3/pip, and ImageMagick in addition to the existing document and browser tooling.

ImageMagick is provided by Debian's ImageMagick 6 package, so agents should use commands such as `convert` and `identify` rather than the ImageMagick 7 `magick` wrapper.

The runtime sandbox integration test verifies these tools with the other baseline CLIs so image changes fail fast if a package is missing.
