const {createServer} = require("node:http"),
  html_page = require("./html-page-template")({
    defaultPageTitle: "Simple HTTP Server",
    headStylesheet: `    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    h1 { color: #333; }
    .info {
      background: #e8f4fd;
      padding: 15px;
      border-radius: 5px;
      margin: 20px 0;
    }
    .details {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 5px;
      margin: 20px 0;
      border-left: 4px solid #007bff;
      overflow-wrap: break-word;
    }
    a {
      color: #007bff;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    code {
      background: #f1f3f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
    }
    .param {
      font-style: italic;
      color: #d35400;
    }`
  }),
  { parseRequestInfo, dateFormat, htmlEscape } = require("./utils"),
  [get_api_method_info, exec_api_method, messageTimestamps, readMessagesFromFile] = require("./rest-api")

const server = createServer((req, res) => {
  const [path, query] = parseRequestInfo(req)
  console.log(`requested resource: ${path}`)
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  if (path === "/") {
    res.statusCode = 200
    let output = "\n  <div class=\"container\">\n    <h1>Chat Messages</h1>\n" +
      "    <p><a href=\"/api-reference\">REST API Methods</a></p>\n",
      messageCounter = 0
      // chatMessagesFile.read
      readMessagesFromFile((message, date)=>{
      output += `    <div class="details">\n      <h3>${dateFormat(date)}</h3>\n      ${htmlEscape(message)}\n    </div>\n`
      messageCounter++
    }, ()=>{
      if (!messageCounter) output += "    <div class=\"info\"><p>No messages</p></div>\n"
      output += "  <\/div>\n"
      html_page(res, output)
    })
    return
  }
  if (path === "/msg-timestamps") {
    res.statusCode = 200
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    readMessagesFromFile((message, timestamp)=>{
      res.write(`\n===== ${timestamp} =====\n${message}\n`)
    }, ()=>{
      res.end()
    })
    return
  }
  if (path === "/api-reference") {
    let sampleTimestamps
    let output = `\n  <div class=\"container\">\n    <h1>REST API Methods</h1>
    <section>
      <p><strong>Message timestamps list:</strong></p>
      <p><code>/api/msg-timestamps</code></p>
    </section>
    <section>
      <p><strong>Read message content:</strong></p>
      <p><code>/api/message/<span class="param">{message_timestamp}</span></code></p>
    </section>
    <section>
      <p><strong>Delete message:</strong></p>
      <p><code>/api/message/<span class="param">{message_timestamp}</span>/delete</code></p>
    </section>
    <section>
      <p><strong>Hint:</strong></p>
      <p>To get <code><span class="param">{message_timestamp}</span></code> use <code>/api/msg-timestamps</code> method</p>
    </section>
    <h2>Examples</h2>
    <ul>
      <li><a href="/api/msg-timestamps">/api/msg-timestamps</a></li>`
    const iterator = messageTimestamps[Symbol.asyncIterator](),
      onFinished = ()=>{
        for (const timestamp of sampleTimestamps)
          output += `\n      <li><a href="/api/message/${timestamp}">/api/message/${timestamp}</a></li>`
        output += "\n    </ul>\n    <hr>\n    <p><a href=\"/\">← Back to the Main Page</a></p>\n  <\/div>\n"
        html_page(res, output)
      }
    if (!messageTimestamps.isReady) {
      sampleTimestamps = []
      const readNext = ({value, done})=>{
        if (done) {
          sampleTimestamps = sampleTimestamps.slice(-3)
          onFinished()
          return
        }
        sampleTimestamps.push(value)
        iterator.next().then(readNext)
      }
      iterator.next().then(readNext)
    }
    else {
      sampleTimestamps = [...iterator].slice(-3)
      onFinished()
    }
    return
  }
  const apiMethodInfo = get_api_method_info(path)
  if (apiMethodInfo != null) {
    exec_api_method(res, apiMethodInfo)
    return
  }
  res.statusCode = 404
  res.removeHeader("Content-Type")
  res.end()
})

const PORT = 3000
const HOST = require("os").hostname()

server.listen(PORT, HOST, ()=>{
  console.log(`HTTP Server listening on https://${HOST}--${PORT}--96435430.local-credentialless.webcontainer.io`)
})