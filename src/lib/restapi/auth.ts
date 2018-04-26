// external dependencies
import * as Express from 'express';
import * as jwt from 'express-jwt';
import * as jwksRsa from 'jwks-rsa';
import * as jwtDecode from 'jwt-decode';
import * as jsonwebtoken from 'jsonwebtoken';
import * as httpstatus from 'http-status';
// local dependencies
import * as errors from './errors';
import * as urls from './urls';
import * as store from '../db/store';
import * as sessionusers from '../sessionusers';
import * as Objects from '../db/db-types';


export interface RequestWithProject extends Express.Request {
    project: Objects.Project;
}



const JWT_SECRET: string = process.env.AUTH0_CLIENT_SECRET as string;



export function generateJwt(payload: object): string {
    return jsonwebtoken.sign(payload, JWT_SECRET, {
        algorithm: 'HS256',
    });
}




/**
 * Auth middleware for all normal users - who are authenticated by Auth0.
 */
const auth0Authenticate = jwt({
    secret : jwksRsa.expressJwtSecret({
        cache : true,
        rateLimit : true,
        jwksRequestsPerMinute : 5,
        jwksUri : `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
    }),

    // cf. https://github.com/auth0/express-jwt/issues/171#issuecomment-305876709
    // audience : process.env.AUTH0_AUDIENCE,
    aud : process.env.AUTH0_AUDIENCE,

    issuer : `https://${process.env.AUTH0_DOMAIN}/`,
    algorithms : [ 'RS256' ],
});



/**
 * Auth middleware for users in the session-users class - who are authenticated locally.
 */
async function sessionusersAuthenticate(
    jwtTokenString: string,
    req: Express.Request, res: Express.Response, next: Express.NextFunction)
{
    let decoded: Objects.TemporaryUser;

    try {
        decoded = jwtDecode(jwtTokenString);
    }
    catch (err) {
        return errors.notAuthorised(res);
    }

    try {
        const sessionUserIsAuthenticated = await sessionusers.checkSessionToken(req.params.studentid, decoded.token);

        if (sessionUserIsAuthenticated) {
            req.user = {
                sub : decoded.id,
                app_metadata : {
                    role : 'student',
                    tenant : sessionusers.CLASS_NAME,
                },
                session : decoded,
            };

            next();
        }
        else {
            errors.notAuthorised(res);
        }
    }
    catch (err) {
        next(err);
    }
}





export function authenticate(req: Express.Request, res: Express.Response, next: Express.NextFunction) {

        // the request is trying to access a resource in the session-users class
    if ((req.params.classid === sessionusers.CLASS_NAME) &&
        // the request includes an auth header
        req.headers.authorization &&
        typeof req.headers.authorization === 'string' &&
        // the auth header has a bearer token
        (req.headers.authorization.split(' ')[0] === 'Bearer'))
    {
        // Access to resources in the session-users class is managed locally
        const jwtToken = req.headers.authorization.split(' ')[1];
        sessionusersAuthenticate(jwtToken, req, res, next);
    }
    else {
        // Access to ALL other resources is managed using Auth0
        auth0Authenticate(req, res, next);
    }
}







function getValuesFromToken(req: Express.Request) {
    if (req.user && !req.user.app_metadata) {
        req.user.app_metadata = {
            role : req.user['https://machinelearningforkids.co.uk/api/role'],
            tenant : req.user['https://machinelearningforkids.co.uk/api/tenant'],
        };
    }
}


export function checkValidUser(req: Express.Request, res: Express.Response, next: Express.NextFunction) {
    getValuesFromToken(req);

    if (!req.user || !req.user.app_metadata) {
        return errors.notAuthorised(res);
    }
    if (req.user.app_metadata.tenant !== req.params.classid) {
        return errors.forbidden(res);
    }

    next();
}

export function requireSupervisor(req: Express.Request, res: Express.Response, next: Express.NextFunction) {
    if (req.user.app_metadata.role !== 'supervisor') {
        return errors.supervisorOnly(res);
    }

    next();
}

export function requireSiteAdmin(req: Express.Request, res: Express.Response, next: Express.NextFunction) {
    getValuesFromToken(req);

    if (req.user.app_metadata.role !== 'siteadmin') {
        return res.status(httpstatus.FORBIDDEN).json({ error : 'Forbidden' });
    }

    next();
}


export async function ensureUnmanaged(
    req: Express.Request, res: Express.Response,
    next: (err?: Error) => void)
{
    const tenant = req.params.classid;

    try {
        const policy = await store.getClassTenant(tenant);
        if (policy.isManaged) {
            return res.status(httpstatus.FORBIDDEN)
                      .json({ error : 'Access to API keys is forbidden for managed tenants' });
        }

        next();
    }
    catch (err) {
        return next(err);
    }
}




async function verifyProjectAuth(
    req: Express.Request,
    res: Express.Response,
    next: (e?: Error) => void,
    isCrowdSourcedAllowed: boolean)
{
    const classid: string = req.params.classid;
    const userid: string = req.params.studentid;
    const projectid: string = req.params.projectid;

    try {
        const project = await store.getProject(projectid);
        if (!project) {
            // attempt to access non-existent project
            return errors.notFound(res);
        }
        if (project.classid !== classid) {
            // attempt to access a project from another class/tenant
            return errors.forbidden(res);
        }
        const isOwner = req.user && (project.userid === req.user.sub) && (project.userid === userid);
        if (isOwner === false) {
            // attempt to access a classmate's project...

            if (!isCrowdSourcedAllowed || !project.isCrowdSourced) {
                // ...and that isn't okay
                return errors.forbidden(res);
            }
        }

        const modifiedRequest: RequestWithProject = req as RequestWithProject;
        modifiedRequest.project = project;

        next();
    }
    catch (err) {
        return next(err);
    }
}


/**
 * API Auth middleware.
 *
 * Ensures that the user is accessing a project that they
 *  have exclusive rights to.
 */
export async function verifyProjectOwner(
    req: Express.Request,
    res: Express.Response,
    next: (e?: Error) => void)
{
    verifyProjectAuth(req, res, next, false);
}

/**
 * API Auth middleware.
 *
 * Ensures that the user is accessing a project that they
 *  have at least read access to.
 */
export async function verifyProjectAccess(
    req: Express.Request,
    res: Express.Response,
    next: (e?: Error) => void)
{
    verifyProjectAuth(req, res, next, true);
}
