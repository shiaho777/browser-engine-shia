# Site adaptation manifests

One JSON manifest per site the engine is being adapted to, in the
"adapt one site fully, then the next" methodology. Each manifest lists the
capability claims and concrete checks that the engine must pass for that
site, and is verified with:

```bash
node packages/app/bin/site-check.mjs docs/sites/bilibili.json
```

The runner loads the URL with guest ESM + keepAlive, pumps continuous
frames, and fails loudly on any unmet check (no silent classification).
Reports are runtime artifacts (network-dependent) and stay out of git;
commit the manifest, not the report.
