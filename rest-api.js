const { read: readFile, openSync, createReadStream } = require("node:fs"),
  chatMessagesFile = require("./chat-messages"),
  responseHeaders = require("./response-headers"),
  messageTimestamps = new Set(),
  prepareMessageTimestamps = callback=>{
    if (!messageTimestamps.size) {
      chatMessagesFile.read((_,date)=>{
        messageTimestamps.add(date)
      }, callback)
      return
    }
    callback()
  },
  apiMethods = new Map([
    ["msg-timestamps", socket=>prepareMessageTimestamps(()=>{
      let output = ""
      for (const timestamp of messageTimestamps)
        output += timestamp + "\n"
      output = output.slice(0, -1)
      if (!output.length)
        output = "no messages"
      socket.end(`${responseHeaders.plainText}${output}`)
    })],
    ["message", (socket, targetMessage)=>{
      targetMessage = Number(targetMessage)
      prepareMessageTimestamps(()=>{
        if (!messageTimestamps.has(targetMessage)) {
          socket.end(responseHeaders.notFoundWithText(`ERROR: message with timestamp ${targetMessage} not found`))
          return
        }
        const position = chatMessagesFile.getOffsetForMessageTimestamp(targetMessage),
          fd = openSync("msg-storage")
        readFile(fd,{position, length:8},(_, __, buffer)=>{
          const length = buffer.readUInt16LE(),
            start = position + 8,
            end = start + length - 1,
            readStream = createReadStream(null, {fd, start, end})
          socket.write(responseHeaders.plainText)
          readStream.pipe(socket)
        })
      })
    }],
    ["message/delete", (socket, messageTimestamp)=>{
      messageTimestamp = Number(messageTimestamp)
      prepareMessageTimestamps(()=>{
        if (!messageTimestamps.has(messageTimestamp)) {
          socket.end(responseHeaders.notFoundWithText(`ERROR: message with timestamp ${messageTimestamp} not found`))
          return
        }
        chatMessagesFile.remove(messageTimestamp, ()=>{
          messageTimestamps.delete(messageTimestamp)
          socket.end(responseHeaders.redirect("/"))
        })
      })
    }]
  ]),
  apiRegexp = /(?<=\/)[^\/]*/g

module.exports = [
  path=>{
    if (path.startsWith("api/")) {
      const pathComponents = path.match(apiRegexp)
      // const pathComponents = path.split("/")
      if (pathComponents.length == 3 && pathComponents[0] == "message" && pathComponents[2] == "delete")
        return ["message/delete", pathComponents[1]]
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