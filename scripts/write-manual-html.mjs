import { mkdir, writeFile } from 'node:fs/promises'

await mkdir('out/renderer', { recursive: true })

await writeFile(
  'out/renderer/index.html',
  `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Niedenthal Emotions Lab</title>
    <link rel="stylesheet" href="./assets/index-manual.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./assets/index-manual.js"></script>
  </body>
</html>
`,
  'utf8'
)
