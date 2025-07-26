const { read: readFile, openSync, createReadStream } = require("node:fs"),
  chatMessagesFile = require("./chat-messages"),
  responseHeaders = require("./response-headers"),
  messageTimestamps = (()=>{
    let timestamps = null
    const iteratorProxy = ()=>{
      if (!timestamps) {
        // эта конструкция нужна для подстраховки
        // на случай если метод read объекта chatMessagesFile
        // ни разу не вызывался. метод read нужно выполнить
        // хотябы один раз, иначе метод getOffsetForMessageTimestamp
        // не сможет получить позицию для чтения данных из файла
        // метод read вызвается при открытии главной страницы
        // но возможны ситуации когда главная страница не открывалась
        // например вместо запроса перехода на главную страницу
        // первым будет обращение к методу REST API и в таком случае
        // метод сработает некорректно, то есть при нынешней структуре
        // модуля chat-messages (объект chatMessagesFile) метод REST API
        // работает корректно только после того когда хотябы один
        // раз был запрос к серверу для отображения главной страницы
        timestamps = new Set()
        let isEOF = false
        const iteratorQueue = new Promise(resolve=>{
          const iteratorQueue = []
          chatMessagesFile.read((_, date)=>{
            timestamps.add(date)
            iteratorQueue.push(new Promise(resolve=>{
              resolve(date)
            }))
            resolve(iteratorQueue)
          }, ()=>{isEOF = true})
        })
        let idx = 0
        const waitForNextEntry = iteratorQueue=>{
          if (!iteratorQueue[idx] && !isEOF)
            return new Promise(resolve=>{
              setTimeout(resolve, 0, iteratorQueue)
            }).then(waitForNextEntry)
          return iteratorQueue[idx]
        }
        return {
          async next() {
            const value = await iteratorQueue.then(waitForNextEntry)
            if (isEOF && idx >= (await iteratorQueue).length)
              return { done: true }
            idx++
            return { value }
          }
        }
      }
      return timestamps[Symbol.iterator]()
    }
    return {
      has: targetTimestamp=> new Promise(resolve=>{
        const iterator = iteratorProxy(),
          waitForNextEntry = iteratorStep=>{
            if (!iteratorStep.done)
              return iterator.next().then(waitForNextEntry)
            resolve(timestamps.has(targetTimestamp))
          }
        if (!iterator.next().then) {
          resolve(timestamps.has(targetTimestamp))
          return
        }
        iterator.next().then(waitForNextEntry)
      }),
      delete: targetTimestamp=>{
        if (!timestamps) return false
        return timestamps.delete(targetTimestamp)
      },
      [Symbol.asyncIterator]: iteratorProxy
    }
  })(),
  apiMethods = new Map([
    ["msg-timestamps", async socket=>{
      let output = ""
      for await (const timestamp of messageTimestamps) {
        output += timestamp + "\n"
      }
      if (!output.length)
        output = "no messages"
      socket.end(`${responseHeaders.plainText}${output}`)
    }],
    ["message", async (socket, targetMessage)=>{
      targetMessage = Number(targetMessage)
      if (!await messageTimestamps.has(targetMessage)) {
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
    }],
    ["message/delete", async (socket, messageTimestamp)=>{
      messageTimestamp = Number(messageTimestamp)
      if (!await messageTimestamps.has(messageTimestamp)) {
        socket.end(responseHeaders.notFoundWithText(`ERROR: message with timestamp ${messageTimestamp} not found`))
        return
      }
      chatMessagesFile.remove(messageTimestamp, ()=>{
        messageTimestamps.delete(messageTimestamp)
        socket.end(responseHeaders.redirect("/"))
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