import { Lexer, Parser, getImage } from "chevrotain";

import _ from "underscore";

import { formatFieldName, formatMetricName, formatExpressionName, formatAggregationName } from "../expressions";

import {
    VALID_AGGREGATIONS,
    allTokens,
    LParen, RParen, Comma,
    AdditiveOperator, MultiplicativeOperator,
    Aggregation,
    StringLiteral, NumberLiteral,
    Identifier
} from "./tokens";

const ExpressionsLexer = new Lexer(allTokens);

const aggregationsMap = new Map(Array.from(VALID_AGGREGATIONS).map(([a,b]) => [b,a]));

class ExpressionsParser extends Parser {
    constructor(input, options = {}) {
        super(input, allTokens/*, { recoveryEnabled: false }*/);

        let $ = this;

        this._options = options;

        // an expression without aggregations in it
        $.RULE("expression", function (outsideAggregation = false) {
            return $.SUBRULE($.additionExpression, [outsideAggregation])
        });

        // an expression with aggregations in it
        $.RULE("aggregation", function () {
            return $.SUBRULE($.additionExpression, [true])
        });

        // Lowest precedence thus it is first in the rule chain
        // The precedence of binary expressions is determined by
        // how far down the Parse Tree the binary expression appears.
        $.RULE("additionExpression", (outsideAggregation) => {
            let initial = $.SUBRULE($.multiplicationExpression, [outsideAggregation]);
            let operations = $.MANY(() => {
                const op = $.CONSUME(AdditiveOperator);
                const rhsVal = $.SUBRULE2($.multiplicationExpression, [outsideAggregation]);
                return [op, rhsVal];
            });
            return this._math(initial, operations);
        });

        $.RULE("multiplicationExpression", (outsideAggregation) => {
            let initial = $.SUBRULE($.atomicExpression, [outsideAggregation]);
            let operations = $.MANY(() => {
                const op = $.CONSUME(MultiplicativeOperator);
                const rhsVal = $.SUBRULE2($.atomicExpression, [outsideAggregation]);
                return [op, rhsVal];
            });
            return this._math(initial, operations);
        });

        $.RULE("aggregationOrMetricExpression", (outsideAggregation) => {
            return $.OR([
                {ALT: () => $.SUBRULE($.aggregationExpression, [outsideAggregation]) },
                {ALT: () => $.SUBRULE($.metricExpression) }
            ]);
        });

        $.RULE("aggregationExpression", (outsideAggregation) => {
            const aggregation = $.CONSUME(Aggregation);
            const lParen = $.CONSUME(LParen);
            const args = $.MANY_SEP(Comma, () => $.SUBRULE($.expression, [false]));
            const rParen = $.CONSUME(RParen);

            return this._aggregation(aggregation, lParen, args, rParen);
        });

        $.RULE("metricExpression", () => {
            const metricName = $.SUBRULE($.identifier);
            const lParen = $.CONSUME(LParen);
            const rParen = $.CONSUME(RParen);

            const metric = this.getMetricForName(this._toString(metricName));
            if (metric != null) {
                return this._metricReference(metricName, metric.id);
            }
            return this._unknownMetric(metricName, lParen, rParen);
        });

        $.RULE("fieldExpression", () => {
            const fieldName = $.OR([
                {ALT: () => $.SUBRULE($.stringLiteral) },
                {ALT: () => $.SUBRULE($.identifier) }
            ]);

            const field = this.getFieldForName(this._toString(fieldName));
            if (field != null) {
                return this._fieldReference(fieldName, field.id);
            }
            const expression = this.getExpressionForName(this._toString(fieldName));
            if (expression != null) {
                return this._expressionReference(fieldName, expression);
            }
            return this._unknownField(fieldName);
        });

        $.RULE("identifier", () => {
            const identifier = $.CONSUME(Identifier);
            return this._identifier(identifier);
        })

        $.RULE("stringLiteral", () => {
            const stringLiteral = $.CONSUME(StringLiteral);
            return this._stringLiteral(stringLiteral);
        })

        $.RULE("numberLiteral", () => {
            const numberLiteral = $.CONSUME(NumberLiteral);
            return this._numberLiteral(numberLiteral);
        })

        $.RULE("atomicExpression", (outsideAggregation) => {
            return $.OR([
                // aggregations not allowed inside other aggregations
                {GATE: () => outsideAggregation, ALT: () => $.SUBRULE($.aggregationOrMetricExpression, [false]) },
                // fields not allowed outside aggregations
                {GATE: () => !outsideAggregation, ALT: () => $.SUBRULE($.fieldExpression) },
                {ALT: () => $.SUBRULE($.parenthesisExpression, [outsideAggregation]) },
                {ALT: () => $.SUBRULE($.numberLiteral) }
            ], "a number or field name");
        });

        $.RULE("parenthesisExpression", (outsideAggregation) => {
            let lParen = $.CONSUME(LParen);
            let expValue = $.SUBRULE($.expression, [outsideAggregation]);
            let rParen = $.CONSUME(RParen);
            return this._parens(lParen, expValue, rParen);
        });

        Parser.performSelfAnalysis(this);
    }

    getFieldForName(fieldName) {
        const fields = this._options.tableMetadata && this._options.tableMetadata.fields;
        return _.findWhere(fields, { display_name: fieldName });
    }

    getExpressionForName(expressionName) {
        const customFields = this._options && this._options.customFields;
        return customFields[expressionName];
    }

    getMetricForName(metricName) {
        const metrics = this._options.tableMetadata && this._options.tableMetadata.metrics;
        return _.find(metrics, (metric) => formatMetricName(metric) === metricName);
    }
}

class ExpressionsParserMBQL extends ExpressionsParser {
    _math(initial, operations) {
        for (const [op, rhsVal] of operations) {
            // collapse multiple consecutive operators into a single MBQL statement
            if (Array.isArray(initial) && initial[0] === op.image) {
                initial.push(rhsVal);
            } else {
                initial = [op.image, initial, rhsVal]
            }
        }
        return initial;
    }
    _aggregation(aggregation, lParen, args, rParen) {
        const aggregationName = aggregation.image;
        return [aggregationsMap.get(aggregationName)].concat(args.values);
    }
    _metricReference(metricName, metricId) {
        return ["METRIC", metricId];
    }
    _fieldReference(fieldName, fieldId) {
        return ["field-id", fieldId];
    }
    _expressionReference(fieldName) {
        return ["expression", fieldName];
    }
    _unknownField(fieldName) {
        throw new Error("Unknown field \"" + fieldName + "\"");
    }
    _unknownMetric(metricName) {
        throw new Error("Unknown metric \"" + metricName + "\"");
    }

    _identifier(identifier) {
        return identifier.image;
    }
    _stringLiteral(stringLiteral) {
        return JSON.parse(stringLiteral.image);
    }
    _numberLiteral(numberLiteral) {
        return parseFloat(numberLiteral.image);
    }
    _parens(lParen, expValue, rParen) {
        return expValue;
    }
    _toString(x) {
        return x;
    }
}

const syntax = (type, ...children) => ({
    type: type,
    children: children
})
const token = (token) => ({
    type: "token",
    text: token.image,
    start: token.startOffset,
    end: token.endOffset,
})

class ExpressionsParserSyntax extends ExpressionsParser {
    _math(initial, operations) {
        return syntax("math", ...[initial].concat(...operations.map(([op, arg]) => [token(op), arg])));
    }
    _aggregation(aggregation, lParen, args, rParen) {
        let argsAndCommas = [];
        for (let i = 0; i < args.values.length; i++) {
            argsAndCommas.push(args.values[i]);
            if (i < args.separators.length) {
                argsAndCommas.push(args.separators[i]);
            }
        }
        return syntax("aggregation", token(aggregation), token(lParen), ...argsAndCommas, token(rParen));
    }
    _metricReference(metricName, metricId) {
        return syntax("metric", metricName);
    }
    _fieldReference(fieldName, fieldId) {
        return syntax("field", fieldName);
    }
    _expressionReference(fieldName) {
        return syntax("expression-reference", token(fieldName));
    }
    _unknownField(fieldName) {
        return syntax("unknown", fieldName);
    }
    _unknownMetric(metricName) {
        return syntax("unknown", metricName);
    }

    _identifier(identifier) {
        return syntax("identifier", token(identifier));
    }
    _stringLiteral(stringLiteral) {
        return syntax("string", token(stringLiteral));
    }
    _numberLiteral(numberLiteral) {
        return syntax("number", token(numberLiteral));
    }
    _parens(lParen, expValue, rParen) {
        return syntax("group", token(lParen), expValue, token(rParen));
    }
    _toString(x) {
        if (typeof x === "string") {
            return x;
        } else if (x.type === "string") {
            return JSON.parse(x.children[0].text);
        } else if (x.type === "identifier") {
            return x.children[0].text;
        }
    }
}

function getSubTokenTypes(TokenClass) {
    return TokenClass.extendingTokenTypes.map(tokenType => _.findWhere(allTokens, { tokenType }));
}

function getTokenSource(TokenClass) {
    // strip regex escaping, e.x. "\+" -> "+"
    return TokenClass.PATTERN.source.replace(/^\\/, "");
}

function run(Parser, source, options) {
    if (!source) {
        return [];
    }
    const { startRule } = options;
    const parser = new Parser(ExpressionsLexer.tokenize(source).tokens, options);
    const expression = parser[startRule]();
    if (parser.errors.length > 0) {
        throw parser.errors;
    }
    return expression;
}

export function compile(source, options = {}) {
    return run(ExpressionsParserMBQL, source, options);
}

export function parse(source, options = {}) {
    return run(ExpressionsParserSyntax, source, options);
}

// No need for more than one instance.
const parserInstance = new ExpressionsParser([])
export function suggest(source, {
    tableMetadata,
    customFields,
    startRule,
    index = source.length
} = {}) {
    const partialSource = source.slice(0, index);
    const lexResult = ExpressionsLexer.tokenize(partialSource);
    if (lexResult.errors.length > 0) {
        throw new Error("sad sad panda, lexing errors detected");
    }

    const lastInputToken = _.last(lexResult.tokens)
    let partialSuggestionMode = false
    let assistanceTokenVector = lexResult.tokens

    // we have requested assistance while inside an Identifier
    if ((lastInputToken instanceof Identifier) &&
        /\w/.test(partialSource[partialSource.length - 1])) {
        assistanceTokenVector = assistanceTokenVector.slice(0, -1);
        partialSuggestionMode = true
    }


    let finalSuggestions = []

    // TODO: is there a better way to figure out which aggregation we're inside of?
    const currentAggregationToken = _.find(assistanceTokenVector.slice().reverse(), (t) => t instanceof Aggregation);

    const syntacticSuggestions = parserInstance.computeContentAssist(startRule, assistanceTokenVector)
    for (const suggestion of syntacticSuggestions) {
        const { nextTokenType, ruleStack } = suggestion;
        // no nesting of aggregations or field references outside of aggregations
        // we have a predicate in the grammar to prevent nested aggregations but chevrotain
        // doesn't support predicates in content-assist mode, so we need this extra check
        const outsideAggregation = startRule === "aggregation" && ruleStack.slice(0, -1).indexOf("aggregationExpression") < 0;

        if (nextTokenType === MultiplicativeOperator || nextTokenType === AdditiveOperator) {
            let tokens = getSubTokenTypes(nextTokenType);
            finalSuggestions.push(...tokens.map(token => ({
                type: "operators",
                name: getTokenSource(token),
                text: " " + getTokenSource(token) + " ",
                prefixTrim: /\s*$/,
                postfixTrim: /^\s*[*/+-]?\s*/
            })))
        } else if (nextTokenType === LParen) {
            finalSuggestions.push({
                type: "other",
                name: "(",
                text: " (",
                postfixText: ")",
                prefixTrim: /\s*$/,
                postfixTrim: /^\s*\(?\s*/
            });
        } else if (nextTokenType === RParen) {
            finalSuggestions.push({
                type: "other",
                name: ")",
                text: ") ",
                prefixTrim: /\s*$/,
                postfixTrim: /^\s*\)?\s*/
            });
        } else if (nextTokenType === Identifier || nextTokenType === StringLiteral) {
            if (!outsideAggregation) {
                let fields = [];
                if (startRule === "aggregation" && currentAggregationToken) {
                    let aggregationShort = aggregationsMap.get(getImage(currentAggregationToken));
                    let aggregationOption = _.findWhere(tableMetadata.aggregation_options, { short: aggregationShort });
                    fields = aggregationOption && aggregationOption.fields && aggregationOption.fields[0] || []
                } else if (startRule === "expression") {
                    fields = tableMetadata.fields;
                }
                finalSuggestions.push(...fields.map(field => ({
                    type: "fields",
                    name: field.display_name,
                    text: formatFieldName(field) + " ",
                    prefixTrim: /\w+$/,
                    postfixTrim: /^\w+\s*/
                })));
                finalSuggestions.push(...Object.keys(customFields || {}).map(expressionName => ({
                    type: "fields",
                    name: expressionName,
                    text: formatExpressionName(expressionName) + " ",
                    prefixTrim: /\w+$/,
                    postfixTrim: /^\w+\s*/
                })));
            }
        } else if (nextTokenType === Aggregation) {
            if (outsideAggregation) {
                finalSuggestions.push(...tableMetadata.aggregation_options.filter(a => formatAggregationName(a)).map(aggregationOption => {
                    const arity = aggregationOption.fields.length;
                    return {
                        type: "aggregations",
                        name: formatAggregationName(aggregationOption),
                        text: formatAggregationName(aggregationOption) + "(" + (arity > 0 ? "" : ")"),
                        postfixText: arity > 0 ? ")" : "",
                        prefixTrim: /\w+$/,
                        postfixTrim: /^\w+(\(\)?|$)/
                    };
                }));
                finalSuggestions.push(...tableMetadata.metrics.map(metric => ({
                    type: "metrics",
                    name: metric.name,
                    text: formatMetricName(metric) + "()",
                    prefixTrim: /\w+$/,
                    postfixTrim: /^\w+(\(\)?|$)/
                })))
            }
        } else if (nextTokenType === NumberLiteral) {
            // skip number literal
        } else {
            console.warn("non exhaustive match", nextTokenType.name, suggestion)
        }
    }

    // throw away any suggestion that is not a suffix of the last partialToken.
    if (partialSuggestionMode) {
        const partial = getImage(lastInputToken).toLowerCase();
        finalSuggestions = _.filter(finalSuggestions, (suggestion) =>
            (suggestion.text && suggestion.text.toLowerCase().startsWith(partial)) ||
            (suggestion.name && suggestion.name.toLowerCase().startsWith(partial))
        );

        let prefixLength = partial.length;
        for (const suggestion of finalSuggestions) {
            suggestion.prefixLength = prefixLength;
        }
    }
    for (const suggestion of finalSuggestions) {
        suggestion.index = index;
        if (!suggestion.name) {
            suggestion.name = suggestion.text;
        }
    }

    // deduplicate suggestions and sort by type then name
    return _.chain(finalSuggestions)
        .uniq(suggestion => suggestion.text)
        .sortBy("name")
        .sortBy("type")
        .value();
}
