'use strict';

const Promise = require('bluebird');
const _ = require('lodash');
const debug = require('debug')('egg-connector-remote:accessContext:acl');

/**
 * Access Control List
 * 访问控制列表
 */

class ACL {
  constructor({ model, property, principalType, principalId, accessType, permission }) {
    this.model = model;
    this.property = property;
    this.principalType = principalType;
    this.principalId = principalId;
    this.accessType = accessType;
    this.permission = permission;
  }
  /**
   * 计算规则得分
   * @param  {Object} [rule={}] [description]
   * @param  {Object} [req={}] AccessRequest
   * @return {Number} score 规则得分
   */
  static getMatchingScore(rule = {}, req) {
    const props = [ 'model', 'property', 'accessType' ];
    let score = 0;
    const rulePropertys = Array.isArray(rule.property) ? rule.property : [ rule.property ];

    for (let i = 0; i < props.length; i++) {
      // Shift the score by 4 for each of the properties as the weight
      score = score * 4;
      const ruleValue = rule[props[i]] || ACL.ALL;
      const requestedValue = req[props[i]] || ACL.ALL;
      const isMatchingMethodName = props[i] === 'property' && rulePropertys.some(property => property === req.property);

      let isMatchingAccessType = ruleValue === requestedValue;
      if (props[i] === 'accessType' && !isMatchingAccessType) {
        switch (ruleValue) {
          case ACL.EXECUTE:
            // EXECUTE should match READ, REPLICATE and WRITE
            isMatchingAccessType = true;
            break;
          // case ACL.WRITE:
            // WRITE should match REPLICATE too
            // isMatchingAccessType = requestedValue === ACL.REPLICATE; ?? REPLICATE 未使用
            // break;
          default:
            break;
        }
      }

      if (isMatchingMethodName || isMatchingAccessType) {
        // Exact match
        score += 3;
      } else if (ruleValue === ACL.ALL) {
        // Wildcard match
        score += 2;
      } else if (requestedValue === ACL.ALL) {
        score += 1;
      } else {
        // Doesn't match at all
        return -1;
      }
    }

    // Weigh against the principal type into 4 levels
    // - user level (explicitly allow/deny a given user)
    // - app level (explicitly allow/deny a given app)
    // - role level (role based authorization)
    // - other
    // user > app > role > ...
    score = score * 4;
    switch (rule.principalType) {
      // TODO: 基于 用户和基于应用的权限管理，暂不支持
      // case ACL.USER:
      //   score += 4;
      //   break;
      // case ACL.APP:
      //   score += 3;
      //   break;
      case ACL.ROLE:
        score += 2;
        break;
      default:
        score += 1;
    }

    // Weigh against the roles
    // everyone < authenticated/unauthenticated < related < owner < ...
    score = score * 8;
    if (rule.principalType === ACL.ROLE) {
      switch (rule.principalId) {
        case '$owner': // XXX:hack
          score += 4;
          break;
        // case '$related': // 暂不需要
        //   score += 3;
        //   break;
        case '$authenticated':
        case '$unauthenticated':
          score += 2;
          break;
        case '$everyone':
          score += 1;
          break;
        default:
          score += 5;
      }
    }
    score = score * 4;
    score += ACL.permissionOrder[rule.permission || ACL.ALLOW] - 1;

    debug('rule: %o, score: %d', rule, score);

    return score;
  }
  static async checkAccessForContext(isInRoleFunc, ctx, modelName, acls = [], curProperty = '', accessType = '', modelId = '') {
    debug('check access in path: %s', ctx.path);
    const staticACLs = ACL.getStaticACLs(modelName, acls, curProperty);
    const matchRoleACLs = staticACLs
      .filter(acl => acl.principalType === ACL.ROLE);

    const req = {
      model: modelName,
      property: curProperty,
      accessType,
    };
    debug('matchRoleACLs : %O', matchRoleACLs);

    const sortMatchRoleACLs = matchRoleACLs.sort(function(rule1, rule2) {
      return ACL.getMatchingScore(rule2, req) - ACL.getMatchingScore(rule1, req);
    });


    const parseMultiRoleACLs = [];
    sortMatchRoleACLs.forEach(item => {
      if (Array.isArray(item.principalId)) {
        item.principalId.forEach(principalIdItem => {
          const cloneItem = _.cloneDeep(item);
          cloneItem.principalId = principalIdItem;
          cloneItem.origin = item;
          parseMultiRoleACLs.push(cloneItem);
        });
      } else {
        const cloneItem = _.cloneDeep(item);
        cloneItem.origin = item;
        parseMultiRoleACLs.push(cloneItem);
      }
    });

    // console.log(acls);
    // console.log(curProperty);
    // 获取最有效的 acl
    const effectiveACLTasks = parseMultiRoleACLs.map(rule => () => isInRoleFunc(ctx, rule.origin, rule, curProperty, modelName, modelId));

    const effectivefirstACL = await Promise.reduce(effectiveACLTasks, (result, fn) => {
      return result ? result : fn().catch(() => {});
    }, null);

    debug('effectivefirstACL: %o', effectivefirstACL);

    return effectivefirstACL ? effectivefirstACL.permission === ACL.ALLOW : true; // 默认允许访问
  }
  /**
   * Get the static ACLs from the model definition
   * 只接受 Model.settings 的配置
   * @param  {String} [ModelName = '']   ModelName
   * @param  {Array}  [acls=[]]     Model.settings.acls
   * @param  {String} [property=''] property The property/method/relation name
   * @return {[type]}               @return {Object[]} An array of ACLs
   */
  static getStaticACLs(ModelName = '', acls = [], property = '') {
    const filterMatchACls = acls.filter(acl => {
      const propertys = Array.isArray(acl.property) ? acl.property : [ acl.property ];
      // * or match in array
      return acl.property === ACL.ALL || propertys.some(item => item === property);
    });

    const staticACLs = filterMatchACls.map(acl => (new ACL({
      model: ModelName,
      property: acl.property,
      principalType: acl.principalType,
      principalId: acl.principalId,
      accessType: acl.accessType || ACL.ALL,
      permission: acl.permission,
    })));

    // Loopback acl 允许额外通过 数据库配置

    return staticACLs;
  }
}

// Define constants for access types
ACL.ALL = '*';

ACL.READ = 'READ'; // Read operation
ACL.REPLICATE = 'REPLICATE'; // Replicate (pull) changes
ACL.WRITE = 'WRITE'; // Write operation
ACL.EXECUTE = 'EXECUTE'; // Execute operation

ACL.DEFAULT = 'DEFAULT'; // Not specified
ACL.ALLOW = 'ALLOW'; // Allow
ACL.ALARM = 'ALARM'; // Warn - send an alarm
ACL.AUDIT = 'AUDIT'; // Audit - record the access
ACL.DENY = 'DENY'; // Deny

ACL.ROLE = 'ROLE';
ACL.APP = 'APP';
ACL.USER = 'USER';

ACL.permissionOrder = {
  DEFAULT: 0,
  ALLOW: 1,
  ALARM: 2,
  AUDIT: 3,
  DENY: 4,
};

module.exports = ACL;
