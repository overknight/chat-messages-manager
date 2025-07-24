const { read: readFile, openSync, close: closeFile,
  createReadStream, createWriteStream, ftruncate } = require("node:fs")

const MSGINFO_RESERVED_BYTES = 8 /* у каждого сообщения первые 8 байт
  хранят служебную информацию, в которой первые 2 байта - размер сообщения в байтах,
  а остальные 6 байт - дата и время сохранения сообщения
  в будущем может понадобиться хранить другую служебную информацию,
  на этот случай и была введена константа MSGINFO_RESERVED_BYTES */

const msgFileOffsets = new Map(),
  fd_readersMap = new Map(),
  writeFileHandlersMap = new Map()
let fileSize, isWriting = false

const pendingOperations = (()=>{
  let head_writeOp = null, head_readOp = null,
    tail_writeOp = null, tail_readOp = null
  const counter = {writing: 0, reading: 0},
    writingQueue = new WeakMap(), readingQueue = new WeakMap()
  return Object.defineProperties({}, {
    counter: {
      value: new Proxy(counter, {
        get: (target, prop)=>{
          return target[prop]
        },
        set: ()=>{
          throw new Error("The counter properties is read only")
        }
      })
    },
    readingNext: {
      get:()=>{
        if (!counter.reading) return null
        counter.reading--
        const op = head_readOp,
          nextOp = readingQueue.get(head_writeOp)
        head_writeOp = !nextOp ? null : nextOp
        if (!counter.writing) tail_writeOp = null
        return op
      }
    },
    writingNext: {
      get:()=>{
        if (!counter.writing) return null
        counter.writing--
        const op = head_writeOp,
          nextOp = writingQueue.get(head_writeOp)
        head_writeOp = !nextOp ? null : nextOp
        if (!counter.writing) tail_writeOp = null
        return op
      }
    },
    scheduleReading: {
      value: callback=>{
        if (!head_readOp)
          head_readOp=callback
        else
          readingQueue.set(tail_readOp, callback)
        tail_readOp=callback
        counter.reading++
      }
    },
    scheduleWriting: {
      value: callback=>{
        if (!head_writeOp)
          head_writeOp=callback
        else
          writingQueue.set(tail_writeOp, callback)
        tail_writeOp=callback
        counter.writing++
      }
    }
  })
})()

const msgWriteStream = createWriteStream("msg-storage", {flags: "a"})

const cb_readMsgText = (err,bytesRead,buffer)=> {
  const fileHandle = fd_readersMap.get(buffer)
  if (!fileHandle) return
  const fd = fileHandle.descriptor
  if (err) {
    closeFile(fd, fileHandle.finishedHandler)
    return
  }
  fileHandle.entryHandler(
    buffer.toString("utf8", 0, bytesRead),
    fileHandle.msgDate
  )
  readFile(fd,{buffer, length:MSGINFO_RESERVED_BYTES},cb_readMsgInfo)
}

const cb_readMsgInfo = (err,bytesRead,buffer)=>{
  const fileHandle = fd_readersMap.get(buffer)
  if (!fileHandle) {
    fd_readersMap.delete(buffer)
    return
  }
  const fd = fileHandle.descriptor
  if (err) {
    fd_readersMap.delete(buffer)
    closeFile(fd, fileHandle.finishedHandler)
    return
  }
  if (bytesRead>0) {
    fileHandle.msgLength = buffer.readUInt16LE()
    fileHandle.msgDate = buffer.readUintLE(2, 6)
    msgFileOffsets.set(fileHandle.msgDate, fileHandle.offset)
    const {msgLength:length} = fileHandle
    fileHandle.offset+=bytesRead+length
    // const {offset} = fileHandle
    // console.log({offset})
    if (buffer.length<length) {
      // console.log(`reallocating buffer size to ${length}`)
      fd_readersMap.delete(buffer)
      buffer = Buffer.alloc(length)
      Object.assign(fileHandle, {buffer})
      fd_readersMap.set(buffer, fileHandle)
    }
    readFile(fd, {buffer, length}, cb_readMsgText)
  } else {
    fd_readersMap.delete(buffer)
    closeFile(fd, fileHandle.finishedHandler)
    if (fileSize === undefined)
      fileSize = fileHandle.offset
    if (pendingOperations.counter.reading>0)
      pendingOperations.readingNext()
  }
}

const onWriteOperationFinished = ()=>{
  if (pendingOperations.counter.writing>0) {
    pendingOperations.writingNext()
    return
  }
  isWriting = false
  if (pendingOperations.counter.reading>0) pendingOperations.readingNext()
}

const append = (msg, timestamp)=>{
  // перед сохранением сообщения нужно убедиться
  // что нет других операций записи в файл
  // добавлять новое сообщение можно только после
  // завершения операций удаления или изменения
  // сообщения, т.к. эти операции делают фрагментацию файла "msg-storage"
  if (!timestamp) timestamp = Date.now()
  msg = Buffer.concat([Buffer.alloc(MSGINFO_RESERVED_BYTES), Buffer.from(msg)])
  msg.writeUInt16LE(msg.length - MSGINFO_RESERVED_BYTES)
  msg.writeUIntLE(timestamp, 2, 6)
  const startWriting = ()=>{
    msgWriteStream.write(msg, onWriteOperationFinished)
    msgFileOffsets.set(timestamp, fileSize)
    fileSize+=msg.length
  }
  if (isWriting) {
    pendingOperations.scheduleWriting(startWriting)
    return
  }
  isWriting = true
  startWriting()
}

const getOffsetForMessageTimestamp = timestamp=>msgFileOffsets.get(timestamp)

const read = (entryHandler, finishedHandler)=>{
  const messageFile = {
    entryHandler,
    finishedHandler
  }
  const startReading=()=>{
    const buffer = Buffer.alloc(MSGINFO_RESERVED_BYTES),
      descriptor = openSync("msg-storage"),
      offset = 0
    fd_readersMap.set(buffer, messageFile)
    Object.assign(messageFile, {descriptor, offset})
    readFile(messageFile.descriptor,{buffer},cb_readMsgInfo)
  }
  if (isWriting) {
    pendingOperations.scheduleReading(startReading)
    return
  }
  startReading()
}

let fileAccessRetryCount = 0

const waitForReadingFinished = callback=>{
  if (fileAccessRetryCount>10) {
    console.log("retry counter exceeded")
    return
  }
  if (fd_readersMap.size>0) {
    setTimeout(()=>{
      fileAccessRetryCount++
      waitForReadingFinished(callback)
    })
    return
  }
  fileAccessRetryCount = 0
  callback()
}

const getAffectedMessageOffsets = timestamp=>{
  const result = [],
    msgIterator = msgFileOffsets.entries()
  let key, value, done
  while(!done) {
    ({value:[key,value]=[],done} = msgIterator.next())
    // console.log({value, done})
    if (key==timestamp) {
      result[0] = value
      break
    }
  }
  result[1]=[]
  for (const [key] of msgIterator)
    result[1].push(key)
  return result
}

const cb_msgRemove_onContentShiftFinished = function(){
  const fileHandle = writeFileHandlersMap.get(this)
  if (!fileHandle) {
    console.error("failed to get file handle")
    return
  }
  const {fd, newFileSize, offsetKeys, targetMsgSize} = fileHandle
  console.log("truncating file")
  ftruncate(fd, newFileSize, err=>{
    if (err) throw err
    for (const k of offsetKeys) {
      const offset = msgFileOffsets.get(k)
      msgFileOffsets.set(k, offset-targetMsgSize)
    }
    closeFile(fd)
    writeFileHandlersMap.delete(this)
    console.log("message removed")
    fileSize=newFileSize
    fileHandle.onFinished()
    onWriteOperationFinished()
  })
}

const cb_msgRemove_getNewFileSize = (err, bytesRead, buffer)=>{
  if (err) throw err
  if (!bytesRead) throw new Error("failed to get new size of the file")
  const fileHandle = writeFileHandlersMap.get(buffer)
  if (!fileHandle) {
    console.error("failed to get file handle")
    return
  }
  const {fd, lastMsgPos, targetMsgPos, targetMsgSize} = fileHandle
  fileHandle.newFileSize = lastMsgPos+buffer.readUInt16LE()+MSGINFO_RESERVED_BYTES-targetMsgSize
  //console.log("shifting contents of file")
  const readStream = createReadStream(null, {fd, autoClose: false, start: targetMsgPos+targetMsgSize})
  const writeStream = createWriteStream(null, {fd, autoClose: false, start: targetMsgPos})
  writeFileHandlersMap.delete(buffer)
  writeFileHandlersMap.set(writeStream, fileHandle)
  writeStream.on("finish", cb_msgRemove_onContentShiftFinished)
  readStream.pipe(writeStream)
}

const cb_getRemovableMessageSize = (err, bytesRead, buffer)=>{
  if (err) throw err
  if (!bytesRead) throw new Error("failed to get message size")
  const fileHandle = writeFileHandlersMap.get(buffer)
  if (!fileHandle) {
    console.error("failed to get file handle")
    return
  }
  const {lastMsgPos} = fileHandle
  fileHandle.targetMsgSize = buffer.readUInt16LE()+MSGINFO_RESERVED_BYTES
  readFile(fileHandle.fd, {position:lastMsgPos, buffer}, cb_msgRemove_getNewFileSize)
}

const cb_msgEdit_onWriteFinish = function(){
  const fileHandle = writeFileHandlersMap.get(this)
  if (!fileHandle) {
    console.error("failed to get file handle")
    return
  }
  const {fd, newFileSize, sizeDifference, offsetKeys} = fileHandle
  writeFileHandlersMap.delete(this)
  if (sizeDifference !== 0) {
    fileSize = newFileSize
    for (const k of offsetKeys) {
      const offset = msgFileOffsets.get(k)
      msgFileOffsets.set(k, offset+sizeDifference)
    }
  }
  if (sizeDifference < 0) {
    //console.log("truncating file")
    ftruncate(fd, newFileSize, err=>{
      //console.log({err})
      closeFile(fd)
      fileHandle.onFinished()
      onWriteOperationFinished()
    })
    return
  }
  fileHandle.onFinished()
  onWriteOperationFinished()
}

const msgEdit_writeData = fileHandle=>{
  if (!fileHandle) throw new Error("File handle not specified")
  const {fd, sizeDifference, targetMsgPos:start, newData} = fileHandle
  const autoClose = sizeDifference >= 0
  const writeStream = createWriteStream(null, {fd, autoClose, start})
  writeFileHandlersMap.set(writeStream, fileHandle)
  writeStream.on("finish", cb_msgEdit_onWriteFinish)
  writeStream.end(newData)
}

const cb_msgEdit_onContentShiftFinished = function(){
  const fileHandle = writeFileHandlersMap.get(this)
  if (!fileHandle) {
    console.error("failed to get file handle")
    return
  }
  writeFileHandlersMap.delete(this)
  msgEdit_writeData(fileHandle)
}

const cb_msgEdit_getNewFileSize = (err, bytesRead, buffer)=>{
  if (err) throw err
  if (!bytesRead) throw new Error("failed to get new size of the file")
  const fileHandle = writeFileHandlersMap.get(buffer)
  if (!fileHandle) {
    console.error("failed to get file handle")
    return
  }
  const {fd, lastMsgPos, targetMsgPos, targetMsgSize, sizeDifference} = fileHandle
  const lastMsgSize = buffer.readUInt16LE()+MSGINFO_RESERVED_BYTES
  fileHandle.newFileSize = lastMsgPos+lastMsgSize+sizeDifference
  writeFileHandlersMap.delete(buffer)
  if (sizeDifference === 0) {
    msgEdit_writeData(fileHandle)
    return
  }
  let start = targetMsgPos+targetMsgSize
  const end = lastMsgPos+lastMsgSize-1,
    readStream = createReadStream(null, {fd, autoClose: false, start, end})
  start += sizeDifference
  const writeStream = createWriteStream(null, {fd, autoClose: false, start})
  writeStream.on("finish", cb_msgEdit_onContentShiftFinished)
  writeFileHandlersMap.set(writeStream, fileHandle)
  //console.log("shifting contents of file")
  readStream.pipe(writeStream)
}

const cb_getEditableMessageSize = (err, bytesRead, buffer)=>{
  if (err) throw err
  if (!bytesRead) throw new Error("failed to get message size")
  const fileHandle = writeFileHandlersMap.get(buffer)
  if (!fileHandle) {
    console.error("failed to get file handle")
    return
  }
  const {newData, targetMsgPos, lastMsgPos:position} = fileHandle
  const targetMsgSize = buffer.readUInt16LE()+MSGINFO_RESERVED_BYTES
  const sizeDifference = newData.length - targetMsgSize
  Object.assign(fileHandle, {targetMsgSize, sizeDifference})
  if (position==targetMsgPos) {
    //console.log("The editable entry is at end of file")
    // если редактируемое сообщение является последним в файле
    // то размер последнего сообщения уже известен
    // также нет необходимости выполнять операции
    // прописанные в функции cb_msgEdit_getNewFileSize
    writeFileHandlersMap.delete(buffer)
    fileHandle.newFileSize = position+targetMsgSize+sizeDifference
    msgEdit_writeData(fileHandle)
    return
  }
  // получение размера последнего сообщения
  readFile(fileHandle.fd, {position,buffer}, cb_msgEdit_getNewFileSize)
}

const remove = (timestamp, onFinished)=>{
  // если поступил новый запрос на удаление сообщения до завершения предыдущей
  // операции удаления или редактирования сообщения, то новый запрос будет добавлен
  // в очередь операций записи и будет выполнен после завершения предыдущей операции
  waitForReadingFinished(()=>{
    //console.log("removing message")
    const [targetMsgPos, offsetKeys] = getAffectedMessageOffsets(timestamp)
    if (targetMsgPos === undefined) throw new Error(`message with timestamp ${timestamp} not found`)
    const lastMsgPos = msgFileOffsets.get(offsetKeys[offsetKeys.length-1])||targetMsgPos
    const handlerInfo = {
      fd: openSync("msg-storage", "r+"),
      lastMsgPos, targetMsgPos,
      offsetKeys, onFinished
    }
    const startWriting = ()=>{
      msgFileOffsets.delete(timestamp)
      if (targetMsgPos != lastMsgPos) {
        const buffer = Buffer.alloc(2)
        writeFileHandlersMap.set(buffer, handlerInfo)
        readFile(handlerInfo.fd, {position:targetMsgPos, buffer}, cb_getRemovableMessageSize)
      } else {
        //console.log("The removable entry is at end of file")
        // в случае когда удаляемое сообщение находится в самом конце файла,
        // то фрагментацию делать не нужно, а достаточно вызвать ftruncate
        ftruncate(handlerInfo.fd, targetMsgPos, err=>{
          if (err) throw err
          closeFile(handlerInfo.fd)
          fileSize=targetMsgPos
          onFinished()
          onWriteOperationFinished()
        })
      }
    }
    if (isWriting) {
      pendingOperations.scheduleWriting(startWriting)
      return
    }
    isWriting = true
    startWriting()
  })
}

const edit = (timestamp, newData, onFinished)=>{
  if (!newData) throw new Error("new data shouldn't be empty")
  waitForReadingFinished(()=>{
    //console.log("modifying message")
    const [targetMsgPos, offsetKeys] = getAffectedMessageOffsets(timestamp)
    if (targetMsgPos === undefined) throw new Error(`message with timestamp ${timestamp} not found`)
    const lastMsgPos = msgFileOffsets.get(offsetKeys[offsetKeys.length-1])||targetMsgPos
    newData = Buffer.concat([Buffer.alloc(MSGINFO_RESERVED_BYTES), Buffer.from(newData)])
    newData.writeUInt16LE(newData.length - MSGINFO_RESERVED_BYTES)
    newData.writeUIntLE(timestamp, 2, 6)
    const handlerInfo = {
      fd: openSync("msg-storage", "r+"),
      lastMsgPos, targetMsgPos,
      offsetKeys, newData, onFinished
    }
    const startWriting = ()=>{
      const buffer = Buffer.alloc(2)
      writeFileHandlersMap.set(buffer, handlerInfo)
      readFile(handlerInfo.fd, {position:targetMsgPos, buffer}, cb_getEditableMessageSize)
    }
    if (isWriting) {
      pendingOperations.scheduleWriting(startWriting)
      return
    }
    isWriting = true
    startWriting()
  })
}

module.exports = {
  getOffsetForMessageTimestamp,
  append,
  read,
  remove,
  edit
}
