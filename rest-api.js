const { read: readFile, openSync, createReadStream } = require("node:fs"),
  chatMessagesFile = require("./chat-messages"),
  responseHeaders = require("./response-headers"),
  messageTimestamps = (()=>{
    let timestamps = null
    const init = ()=>{
      const createIteratorEntry = value=>{
        const ent = {
          value
        }
        ent.nextEntry = new Promise(resolveNext=>{
          Object.assign(ent, {resolveNext})
        })
        return ent
      }
      return new Promise(resolve=>{
        let currentEntry = null,
          prevEntry = null
        timestamps = new Set()
        chatMessagesFile.read((_, date)=>{
          timestamps.add(date)
          if (!currentEntry) {
            currentEntry = createIteratorEntry(date)
            resolve(currentEntry)
            return
          }
          prevEntry = currentEntry
          currentEntry = createIteratorEntry(date)
          prevEntry.resolveNext(currentEntry)
          prevEntry = null
        }, ()=>{
          currentEntry.resolveNext({})
          currentEntry = null
        })
      })
    }
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
        return {
          current: init(),
          async next() {
            const {value, nextEntry} = await this.current
            if (!value) return { done: true }
            this.current = nextEntry
            return { value }
          }
        }
      }
      return timestamps[Symbol.iterator]()
    }
    return {
      has: targetTimestamp=> new Promise(resolve=>{
        if (!timestamps) {
          let isFound = false
          const waitForNext = ent=>{
            if (!ent.value) {
              resolve(isFound)
              return
            }
            if (ent.value == targetTimestamp) isFound = true
            return ent.nextEntry.then(waitForNext)
          }
          init().then(waitForNext)
          return
        }
        resolve(timestamps.has(targetTimestamp))
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