const valueParser = require('postcss-value-parser')

const {
  normalizeUrl,
  resolveRequests,
  isURLRequestable,
  requestify,
  WEBPACK_IGNORE_COMMENT_REGEXP
} = require('../utils')

const MPX_IMPORT_REGEXP = /^(@mpx-import\s+)/ // 例如匹配： ' @mpx-import "xxx"'

function parseNode (atRule, key, options) {
  // Convert only top-level @import

  if (atRule.parent.type !== 'root') {
    return
  }

  if (
    atRule.raws &&
    atRule.raws.afterName &&
    atRule.raws.afterName.trim().length > 0
  ) {
    const lastCommentIndex = atRule.raws.afterName.lastIndexOf('/*')

    const matched = atRule.raws.afterName
      .slice(lastCommentIndex)
      .match(WEBPACK_IGNORE_COMMENT_REGEXP)

    if (matched && matched[2] === 'true') {
      return
    }
  }

  const prevNode = atRule.prev()

  if (prevNode && prevNode.type === 'comment') {
    const matched = prevNode.text.match(WEBPACK_IGNORE_COMMENT_REGEXP)

    if (matched && matched[2] === 'true') {
      return
    }
  }

  // Nodes do not exists - `@import url('http://') :root {}`
  if (atRule.nodes) {
    const error = new Error(
      "It looks like you didn't end your @import statement correctly. Child nodes are attached to it."
    )

    error.node = atRule

    throw error
  }

  const rawParams =
    atRule.raws &&
    atRule.raws[key] &&
    typeof atRule.raws[key].raw !== 'undefined'
      ? atRule.raws[key].raw
      : atRule[key]
  const { nodes: paramsNodes } = valueParser(rawParams)

  // No nodes - `@import ;`
  // Invalid type - `@import foo-bar;`
  if (
    paramsNodes.length === 0 ||
    (paramsNodes[0].type !== 'string' && paramsNodes[0].type !== 'function')
  ) {
    const error = new Error(`Unable to find uri in "${atRule.toString()}"`)

    error.node = atRule

    throw error
  }

  let isStringValue
  let url

  if (paramsNodes[0].type === 'string') {
    isStringValue = true
    url = paramsNodes[0].value
  } else {
    // Invalid function - `@import nourl(test.css);`
    if (paramsNodes[0].value.toLowerCase() !== 'url') {
      const error = new Error(`Unable to find uri in "${atRule.toString()}"`)

      error.node = atRule

      throw error
    }

    isStringValue =
      paramsNodes[0].nodes.length !== 0 &&
      paramsNodes[0].nodes[0].type === 'string'
    url = isStringValue
      ? paramsNodes[0].nodes[0].value
      : valueParser.stringify(paramsNodes[0].nodes)
  }

  url = normalizeUrl(url, isStringValue)

  const { requestable, needResolve } = isURLRequestable(url, options)

  let prefix

  if (requestable && needResolve) {
    const queryParts = url.split('!')

    if (queryParts.length > 1) {
      url = queryParts.pop()
      prefix = queryParts.join('!')
    }
  }

  // Empty url - `@import "";` or `@import url();`
  if (url.trim().length === 0) {
    const error = new Error(`Unable to find uri in "${atRule.toString()}"`)

    error.node = atRule

    throw error
  }

  const additionalNodes = paramsNodes.slice(1)

  let supports
  let layer
  let media

  if (additionalNodes.length > 0) {
    let nodes = []

    for (const node of additionalNodes) {
      nodes.push(node)

      const isLayerFunction =
        node.type === 'function' && node.value.toLowerCase() === 'layer'
      const isLayerWord =
        node.type === 'word' && node.value.toLowerCase() === 'layer'

      if (isLayerFunction || isLayerWord) {
        if (isLayerFunction) {
          nodes.splice(nodes.length - 1, 1, ...node.nodes)
        } else {
          nodes.splice(nodes.length - 1, 1, {
            type: 'string',
            value: '',
            unclosed: false
          })
        }

        layer = valueParser.stringify(nodes).trim().toLowerCase()
        nodes = []
      } else if (
        node.type === 'function' &&
        node.value.toLowerCase() === 'supports'
      ) {
        nodes.splice(nodes.length - 1, 1, ...node.nodes)

        supports = valueParser.stringify(nodes).trim().toLowerCase()
        nodes = []
      }
    }

    if (nodes.length > 0) {
      media = valueParser.stringify(nodes).trim().toLowerCase()
    }
  }

  // eslint-disable-next-line consistent-return
  return {
    atRule,
    prefix,
    url,
    layer,
    supports,
    media,
    requestable,
    needResolve
  }
}

const plugin = (options = {}) => {
  return {
    postcssPlugin: 'postcss-import-parser',
    prepare (result) {
      const parsedAtRules = []

      return {
        Once (root, { AtRule }) {
          // Calls once per file, since every file has single Root
          // 遍历AST 找到注释节点(/* @mpx-import "xxx" */)进行@import 替换
          root.walkComments((comment) => {
            if (MPX_IMPORT_REGEXP.test(comment.text)) {
              const importStatement = comment.text.replace(MPX_IMPORT_REGEXP, (matchStr, $1) => {
                return matchStr.replace($1, '')
              })

              const matched = importStatement.match(/(["'].+["'])/)

              if (matched && matched[1]) {
                const url = matched[1]
                const importNode = new AtRule({ name: 'import', params: url, source: comment.source })
                comment.before(importNode)
                comment.remove()
              }
            }
          })
        },
        AtRule: {
          import (atRule) {
            if (options.isCSSStyleSheet) {
              options.loaderContext.emitError(
                new Error(
                  atRule.error(
                    "'@import' rules are not allowed here and will not be processed"
                  ).message
                )
              )

              return
            }

            const { isSupportDataURL, isSupportAbsoluteURL } = options

            let parsedAtRule

            try {
              parsedAtRule = parseNode(atRule, 'params', {
                isSupportAbsoluteURL,
                isSupportDataURL,
                externals: options.externals
              })
            } catch (error) {
              result.warn(error.message, { node: error.node })
            }

            if (!parsedAtRule) {
              return
            }

            parsedAtRules.push(parsedAtRule)
          }
        },
        async OnceExit () {
          if (parsedAtRules.length === 0) {
            return
          }

          const { loaderContext } = options
          const resolver = loaderContext.getResolve({
            dependencyType: 'css',
            conditionNames: ['style'],
            mainFields: ['css', 'style', 'main', '...'],
            mainFiles: ['index', '...'],
            extensions: ['.css', '...'],
            preferRelative: true
          })

          const resolvedAtRules = await Promise.all(
            parsedAtRules.map(async (parsedAtRule) => {
              const {
                atRule,
                requestable,
                needResolve,
                prefix,
                url,
                layer,
                supports,
                media
              } = parsedAtRule

              if (options.filter) {
                const needKeep = await options.filter(
                  url,
                  media,
                  loaderContext.resourcePath,
                  supports,
                  layer
                )

                if (!needKeep) {
                  return
                }
              }

              if (needResolve) {
                const request = requestify(url, loaderContext.rootContext)
                const resolvedUrl = await resolveRequests(
                  resolver,
                  loaderContext.context,
                  [...new Set([request, url])]
                )

                if (!resolvedUrl) {
                  return
                }

                if (resolvedUrl === loaderContext.resourcePath) {
                  atRule.remove()

                  return
                }

                atRule.remove()

                // eslint-disable-next-line consistent-return
                return {
                  url: resolvedUrl,
                  layer,
                  supports,
                  media,
                  prefix,
                  requestable
                }
              }

              atRule.remove()

              // eslint-disable-next-line consistent-return
              return { url, layer, supports, media, prefix, requestable }
            })
          )

          const urlToNameMap = new Map()

          for (let index = 0; index <= resolvedAtRules.length - 1; index++) {
            const resolvedAtRule = resolvedAtRules[index]

            if (!resolvedAtRule) {
              // eslint-disable-next-line no-continue
              continue
            }

            const { url, requestable, layer, supports, media } = resolvedAtRule

            if (!requestable) {
              options.api.push({ url, layer, supports, media, index })

              // eslint-disable-next-line no-continue
              continue
            }

            const { prefix } = resolvedAtRule
            const newUrl = prefix ? `${prefix}!${url}` : url
            let importName = urlToNameMap.get(newUrl)

            if (!importName) {
              importName = `___CSS_LOADER_AT_RULE_IMPORT_${urlToNameMap.size}___`
              urlToNameMap.set(newUrl, importName)

              options.imports.push({
                type: 'rule_import',
                importName,
                url: options.urlHandler(newUrl),
                index
              })

              options.api.push({ importName, layer, supports, media, index })
            }
          }
        }
      }
    }
  }
}

plugin.postcss = true

module.exports = plugin
