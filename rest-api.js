const { read: readFile, openSync, close: closeFile } = require("node:fs"),
  chatMessagesFile = require("./chat-messages"),
  readChatMessageAtFileOffset= (fd, position, callback)=>readFile
  (fd,{position, length:8},(_, __, buffer)=>{
    const length = buffer.readUInt16LE()
    position += 8
    readFile(fd, {position, length}, (err,bytesRead,buffer)=>{
      if (err) {
        closeFile(fd)
        return
      }
      callback(buffer.toString("utf8", 0, bytesRead))
    })
  }),
  [messageTimestamps, createMessageIterator] = (()=>{
    let timestamps = null,
      readyStatus = false
    const createMessageIterator = ()=>{
      const createIteratorEntry = (message, timestamp)=>{
        const ent = {message, timestamp}
        ent.nextEntry = new Promise(resolveNext=>{
          Object.assign(ent, {resolveNext})
        })
        return ent
      }
      return new Promise(resolve=>{
        let currentEntry = null
        timestamps = new Set()
        chatMessagesFile.read((message, date)=>{
          timestamps.add(date)
          if (!currentEntry) {
            currentEntry = createIteratorEntry(message, date)
            resolve(currentEntry)
            return
          }
          const prevEntry = currentEntry
          currentEntry = createIteratorEntry(message, date)
          prevEntry.resolveNext(currentEntry)
        }, ()=>{
          if (!currentEntry) 
            resolve({})
          else
            currentEntry.resolveNext({})
          currentEntry = null
          readyStatus = true
        })
      })
    },
      iteratorProxy = ()=>{
        if (!readyStatus) {
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
          return {
            current: createMessageIterator(),
            async next() {
              const {timestamp: value, nextEntry} = await this.current
              if (!nextEntry) return { done: true }
              this.current = nextEntry
              return { value }
            }
          }
        }
        return timestamps[Symbol.iterator]()
      }
    return [
      Object.create(null, {
        isReady: {
          get: ()=>readyStatus
        },
        has: {
          value: targetTimestamp=> new Promise(resolve=>{
            if (!readyStatus) {
              let isFound = false
              const waitForNext = ent=>{
                if (!ent.nextEntry) {
                  resolve(isFound)
                  return
                }
                if (ent.timestamp == targetTimestamp) isFound = true
                return ent.nextEntry.then(waitForNext)
              }
              createMessageIterator().then(waitForNext)
              return
            }
            resolve(timestamps.has(targetTimestamp))
          })
        },
        delete: {
          value: targetTimestamp=>{
            if (!timestamps) return false
            return timestamps.delete(targetTimestamp)
          }
        },
        [Symbol.asyncIterator]: {
          value: iteratorProxy
        }
      }), createMessageIterator
    ]
  })(),
  apiMethods = new Map([
    ["msg-timestamps", async res=>{
      let output = ""
      for await (const timestamp of messageTimestamps) {
        output += timestamp + "\n"
      }
      if (!output.length)
        output = "no messages"
      res.setHeader("Content-Type", "text/plain; charset=utf-8")
      res.end(output)
    }],
    ["message", async (res, targetMessage)=>{
      targetMessage = Number(targetMessage)
      if (!await messageTimestamps.has(targetMessage)) {
        res.statusCode = 404
        res.setHeader("Content-Type", "text/plain; charset=utf-8")
        res.end(`ERROR: message with timestamp ${targetMessage} not found`)
        return
      }
      const fd = openSync("msg-storage", "r+"),
        position = chatMessagesFile.getOffsetForMessageTimestamp(targetMessage)
      readChatMessageAtFileOffset(fd, position, message=>{
        closeFile(fd)
        if (!message) {
          res.statusCode = 404
          res.setHeader("Content-Type", "text/plain; charset=utf-8")
          res.end("failed to read message")
          return
        }
        res.statusCode = 200
        res.setHeader("Content-Type", "text/plain; charset=utf-8")
        res.end(message)
      })
    }],
    ["message/delete", async (res, messageTimestamp)=>{
      console.log(`removing message with timestamp ${messageTimestamp}`)
      messageTimestamp = Number(messageTimestamp)
      if (!await messageTimestamps.has(messageTimestamp)) {
        res.statusCode = 404
        res.setHeader("Content-Type", "text/plain; charset=utf-8")
        res.end(`ERROR: message with timestamp ${messageTimestamp} not found`)
        return
      }
      chatMessagesFile.remove(messageTimestamp, ()=>{
        messageTimestamps.delete(messageTimestamp)
        res.statusCode = 301
        res.setHeader("Location", "/")
        res.end()
      })
    }]
  ])

module.exports = [
  path=>{
    if (path.startsWith("/api/")) {
      const pathComponents = path.replace(/^\/api\//, "").split("/")
      if (pathComponents.length == 3 && pathComponents[0] == "message" && pathComponents[2] == "delete")
        return ["message/delete", pathComponents[1]]
      if (pathComponents[1] == "message" && pathComponents.length != 2)
        return null
      if (!apiMethods.has(pathComponents[0]))
        return null
      return pathComponents
    }
    return null
  },
  (res, apiMethod)=>{
    const [, ...apiMethodArgs] = apiMethod
    apiMethod = apiMethod[0]
    apiMethods.get(apiMethod)(res, ...apiMethodArgs)
  },
  messageTimestamps,
  (entryHandler, onFinished)=>{
    if (!messageTimestamps.isReady) {
      const readNext = ent=>{
        const {timestamp, message, nextEntry} = ent
        if (!nextEntry) {
          onFinished()
          return
        }
        entryHandler(message, timestamp)
        nextEntry.then(readNext)
      }
      createMessageIterator().then(readNext)
      return
    }
    const queue = [],
      fd = openSync("msg-storage", "r+")
    for (const timestamp of messageTimestamps[Symbol.asyncIterator]()) {
      const position = chatMessagesFile.getOffsetForMessageTimestamp(timestamp)
      queue.push(new Promise(resolve=>{
        readChatMessageAtFileOffset(fd, position, message=>{
          entryHandler(message, timestamp)
          resolve()
        })
      }))
    }
    Promise.all(queue).then(()=>{
      closeFile(fd)
      onFinished()
    })
  }
]