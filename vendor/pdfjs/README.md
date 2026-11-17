# Mozilla PDF.js

Bundled unmodified from the `pdfjs-dist` npm package, pinned at **6.5.438**.

- Source release https://github.com/mozilla/pdf.js/releases/tag/v6.5.438
- Package URL https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz
- Package integrity `sha512-vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==`
- Local modules `legacy/build/pdf.min.mjs` and `legacy/build/pdf.worker.min.mjs`
- Local character maps `cmaps`, including their upstream license
- Parser license Apache-2.0, see [LICENSE](LICENSE)

The extension only imports these packaged files. It extracts text without loading a viewer, renderer, script sandbox, or WebAssembly. The local module worker and main module must be updated together.
