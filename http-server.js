const { createServer } = require("node:net"),
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
    }
    a {
      color: #007bff;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }`
  }),
  responseHeaders = require("./response-headers"),
  chatMessagesFile = require("./chat-messages"),
  { parseHttpHeaders, dateFormat, htmlEscape } = require("./utils")

process.env.TZ = "Europe/Moscow"

const socketDataHandler = function(data) {
  const socket = this
  const headers = parseHttpHeaders(...data.toString().split("\r\n\r\n")[0].split("\r\n"))
  // console.log(!headers.path ? "requested main page" : `requested resource: ${headers.path}`)
  if (!headers.path) {
    socket.write(responseHeaders.html)
    let output = "\n  <div class=\"container\">\n    <h1>Chat Messages</h1>\n" +
      "    <p><a href=\"/api/msg-timestamps\">Message timestamps</a></p>\n",
      messageCounter = 0
    chatMessagesFile.read((message, date)=>{
      output += `    <div class="details">\n      <h3>${dateFormat(date)}</h3>\n      ${htmlEscape(message)}\n    </div>\n`
      messageCounter++
    }, ()=>{
      if (!messageCounter) output += "    <div class=\"info\"><p>No messages</p></div>\n"
      output += "  <\/div>\n"
      html_page(socket, output)
    })
    return
  }
  if (headers.path == "api/msg-timestamps") {
    socket.write(responseHeaders.plainText)
    let output = ""
    chatMessagesFile.read((_, date)=>{
      output += date + "\n"
    }, ()=>{
      output = output.slice(0, -1)
      if (!output.length)
        output = "no messages"
      socket.end(output)
    })
    return
  }
  socket.end(responseHeaders.notFound)
}

const server = createServer(socket=>{
  socket.on("data", socketDataHandler)
})

const PORT = 3000

server.listen(PORT, ()=>{
  console.log(`Server address: https://${process.env.CODESPACE_NAME}-${PORT}.app.github.dev`)
})