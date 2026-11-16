# pdf.js (vendored)

PDF rendering for the take-off viewer. Served from this folder only; never loaded from the internet.

- Package: `pdfjs-dist` version **4.10.38** (Mozilla, Apache License 2.0, see `LICENSE`)
- Source tarball: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz (fetched with `npm pack pdfjs-dist@4.10.38`)
- Copied unchanged from the tarball: `package/build/pdf.min.mjs`, `package/build/pdf.worker.min.mjs`, `package/LICENSE`

| File | sha256 |
|---|---|
| `pdf.min.mjs` | `27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c` |
| `pdf.worker.min.mjs` | `1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36` |
| `LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |

`test-takeoff.js` checks these hashes. To update: `npm pack` the new version outside the repository, copy the same three
files, update the version, URL and hashes here, and run the tests.
