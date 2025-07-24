const htmlEscape = (()=>{
  const replacer = m=>replacements[m],
    replacements = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  },
    regexp = new RegExp("["+Object.keys(replacements).join("")+"]", "g")
  return htmlString => htmlString.replace(regexp, replacer)
})()

const toCamelCase = (()=>{
  const regexp = /-(.)/g,
    replacer = (_,l)=>l.toUpperCase()
  return str=>str.toLowerCase().replace(regexp, replacer)
})()

module.exports = {
  htmlEscape,
  parseHttpHeaders: (requestLine, ...headerLines)=>{
    let result = {};
    [,result.path] = requestLine.split(" ")
    if (result.path)
      result.path = result.path.replace(/^\//, "")
    if (!result.path) delete result.path
    for (const line of headerLines) {
      const [k,v] = line.split(": ")
      result[toCamelCase(k)] = v
    }
    return Object.freeze(result)
  },
  dateFormat: timestamp => {
    const date = new Date(timestamp)
    return `0${date.getDate()}`.slice(-2)+"."+`0${date.getMonth()+1}`.slice(-2)+"."+`${date.getFullYear()}`+" "+
    `0${date.getHours()}`.slice(-2)+":"+`0${date.getMinutes()}`.slice(-2)+":"+`0${date.getSeconds()}`.slice(-2)
  }
}