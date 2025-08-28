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

module.exports = {
  htmlEscape,
  parseRequestInfo: req => {
    if (!req.url) return []
    const info = req.url.match(regexp_extractQuery) || []
    return [info[1], new URLSearchParams(info[2])]
  },
  dateFormat: timestamp => {
    const date = new Date(timestamp)
    return `0${date.getDate()}`.slice(-2)+"."+`0${date.getMonth()+1}`.slice(-2)+"."+`${date.getFullYear()}`+" "+
    `0${date.getHours()}`.slice(-2)+":"+`0${date.getMinutes()}`.slice(-2)+":"+`0${date.getSeconds()}`.slice(-2)
  }
}