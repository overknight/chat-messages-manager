const htmlStart = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="ie=edge">
`,
  htmlCloseHeadOpenBody = "</head>\n<body>",
  htmlEnd = "</body>\n</html>"

module.exports = options => {
  if (!options) options = {}
  const {headStylesheet, defaultPageTitle} = options
  return (res, pageContent, pageTitle) => {
    if (!pageTitle) pageTitle = defaultPageTitle
    res.write(htmlStart)
    if (!!pageTitle) res.write(`  <title>${pageTitle}</title>\n`)
    if (!!headStylesheet) res.write(`  <style>\n${headStylesheet}\n  </style>\n`)
    res.write(htmlCloseHeadOpenBody)
    res.write(pageContent)
    res.end(htmlEnd)
  }
}