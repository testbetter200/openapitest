const _ = require('lodash')
const YAML = require('yamljs')
const objectPath = require('object-path')
const SuperClient = require('./superClient')

const processedExpectations = ['status', 'json', 'headers', 'error']

module.exports = function apiCall(file, apiPort) {
  const config = init(file)

  const openSpec = apiPort.get('OPENAPI_SPEC')
  const operations = apiPort.get('OPENAPI_OPERATIONS')

  const { paths, ...remainingSpec } = openSpec
  const operationIds = {}

  for (const route of Object.keys(paths)) {
    const actions = paths[route]

    for (const action of Object.keys(actions)) {
      const details = actions[action]

      operationIds[details.operationId] = Object.assign({}, remainingSpec, {
        paths: {
          [route]: {
            [action]: details
          }
        }
      })
    }
  }

  config.apiCalls.swagger.forEach(req => {
    it(req.name || req.call, async function () {
      this.timeout(apiPort.get('TIMEOUT'))

      if (!operationIds[req.call]) {
        throw new Error(`No swagger operation exists with operationId "${req.call}"`)
      }

      let params = req.parameters || ''
      if (params) {
        apiPort.validateParams(operations[req.call].parameters || [], params)
      }

      let allReqData = {}
      let reqData = req.data || {}
      let basicAuth = req.basicAuth || {}
      if (basicAuth.$file) {
        basicAuth = apiPort.getDataFromFile(basicAuth.$file)
        basicAuth = apiPort.resolveObject(basicAuth)
        delete basicAuth.$file
      }

      req.header = apiPort.resolveObject(req.header)
      let query = apiPort.resolveObject(req.query)

      if (reqData.$file) {
        let reqDataFile = apiPort.getDataFromFile(reqData.$file)
        allReqData = apiPort.resolveObject(reqDataFile)
        delete reqData.$file
      } else {
        allReqData = apiPort.resolveObject(reqData)
      }

      const isResPrint = req.print || false

      try {
        const res = await SuperClient(apiPort, req, operations[req.call], allReqData, basicAuth)

        if (isResPrint) {
          varDump('Response= ', res, true)
        }

        if (req.expect) {
          verifyExpectStructure(req.expect)
          apiPort.expectStatus(req.expect.status, res.status)

          if (req.expect.text) {
            apiPort.expectationOn(res.text, req.expect.text)
          }

          if (res.text && isJson(res.text)) {
            res.json = JSON.parse(res.text)
          }

          if (req.expect.json) {
            for (const expectation of req.expect.json) {
              apiPort.expectationOn(res.json, expectation)
            }
          }

          if (req.expect.headers) {
            for (const expectedHeader of req.expect.headers) {
              apiPort.expectationOn(res.header, expectedHeader)
            }
          }
        }

        const save = req.save || {}
        for (const varName of Object.keys(save)) {
          if (typeof save[varName] === 'object') {
            let savedValue = evaluateResponseData(res, save[varName])
            apiPort.set(varName, savedValue)
            if (isResPrint) {
              console.log(varName + ' = ', JSON.stringify(savedValue))
            }
          } else {
            if (save[varName].startsWith('$file.')) {
              apiPort.set(varName, apiPort.resolve(save[varName]))
              if (isResPrint) {
                console.log(varName + ' = ', JSON.stringify(apiPort.resolve(save[varName])))
              }
            } else {
              let value = getValueFromResponse(res, save[varName])
              apiPort.set(varName, value, false)
              if (isResPrint) {
                console.log(varName + ' = ', JSON.stringify(value))
              }
            }
          }
        }
      } catch (err) {
        if (isResPrint) {
          varDump('Error= ', err, true)
        }
        if ((req.expect || {}).status && err.status) {
          apiPort.expectStatus(req.expect.status, err.status)
        } else if ((req.expect || {}).error && err.error) {
          apiPort.expectStatus(req.expect.error, err.error)
        } else {
          throw err
        }
      }
    })
  })
}

function init(file) {
  const fileContent = YAML.load(file)

  fileContent.apiCalls = fileContent.apiCalls || {}
  fileContent.apiCalls.swagger = fileContent.apiCalls.swagger || []

  return fileContent
}

function evaluateResponseData(res, save) {
  let keys = Object.keys(save)
  if (keys.length > 1) {
    throw new Error(`Multiple keys do not support. '${JSON.stringify(save)}'`)
  }

  let keyName = keys[0]
  if (save[keyName].startsWith('$regex')) {
    let value = getValueFromResponse(res, keyName)
    if (!value) {
      throw new Error(`Wrong key '${keyName}'`)
    }
    const parts = save[keyName].split(' ')
    if (parts.length === 2) {
      let matchedValue = value.match(parts[1])
      if (matchedValue) {
        if (matchedValue.length === 1) {
          return matchedValue[0]
        } else if (matchedValue.length === 2) {
          return matchedValue[1]
        }
        throw new Error(
          `Found multiple values '${matchedValue}' using regular expression '${parts[1]}'`
        )
      }
      throw new Error(`Did not parse from value '${value}' using regular expression '${parts[1]}'`)
    } else {
      throw new Error(`Wrong format: '${save[keyName]}'. Expecting like: '$regex ([a-z\\d]+)$'`)
    }
  } else {
    throw new Error('Did not find \'$regex\'. Expecting like: \'$regex ([a-z\\d]+)$\'')
  }
}

function getValueFromResponse(res, key) {
  if (key.startsWith('json.')) {
    res.json = res.json || JSON.parse(res.text)
  }

  return objectPath.get(res, key)
}

function varDump(name, obj, isStr) {
  if (isStr) {
    console.log(name, JSON.stringify(obj, null, 2))
  } else {
    console.log(name, obj)
  }
}

function verifyExpectStructure(callExpects) {
  // a misspelling of a key could result in expectations being skipped
  // therefore, make sure that the keys in the expect object are
  // ones that are processed. Any that fall outside this list will cause
  // the test to fail
  const expectKeys = Array.from(Object.keys(callExpects))
  const unknownKeys = _.difference(expectKeys, processedExpectations)
  if (unknownKeys.length > 0) {
    throw new Error(
      `Only certain expectations are processed - unknown ones have been detected: ${_.join(
        unknownKeys
      )}`
    )
  }
  // now make sure the processed keys are what we exepct
  if (callExpects.json && !Array.isArray(callExpects.json)) {
    throw new Error(`json must be an array of expectations. Found: ${typeof callExpects.json}`)
  }
}

function isJson(str) {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
}