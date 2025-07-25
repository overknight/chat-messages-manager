const chatMessagesFile = require("./chat-messages"),
  responseHeaders = require("./response-headers"),
  apiMethods = new Map([
    ["msg-timestamps", socket=>{
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
    }],
    ["message", (socket, targetMessage)=>{
      targetMessage = Number(targetMessage)
      let found = false
      chatMessagesFile.read((message, messageTimestamp)=>{
        if (messageTimestamp == targetMessage) {
          socket.end(`${responseHeaders.plainText}${message}`)
          found = true
        }
        // метод read объекта chatMessagesFile не предусмотрен для поиска записей поэтому при каждом вызове метода REST API
        // будет осуществляться проход по всему файлу msg-storage, даже если запись найдена в начале файла
      }, ()=>{
        if (!found) socket.end(responseHeaders.notFoundWithText(`ERROR: message with timestamp ${targetMessage} not found`))
      })
    }]
  ]),
  apiRegexp = /(?<=\/)[^\/]*/g

module.exports = [
  path=>{
    if (path.startsWith("api/")) {
      const pathComponents = path.match(apiRegexp)
      // const pathComponents = path.split("/")
      if (pathComponents[0] == "message" && pathComponents.length != 2)
        return null
      if (!apiMethods.has(pathComponents[0]))
        return null
      return pathComponents
    }
    return null
  },
  (socket, apiMethod)=>{
    const [, ...apiMethodArgs] = apiMethod
    apiMethod = apiMethod[0]
    apiMethods.get(apiMethod)(socket, ...apiMethodArgs)
  }
]