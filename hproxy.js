#!/usr/bin/env node
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const stream = require('stream');
const zlib = require('zlib');
const express = require('express');
const forge = require('node-forge');
const argv = require('yargs').usage('Usage: $0 [options]')
.alias({h: 'help', p: 'port'})
.describe({
    port: 'Listening port',
    limit: 'Max size of body to keep',
    www: 'Web interface port',
})
.default({
    port: 8080,
    limit: 1024*64,
    www: 8085,
}).help('h').argv;

const app = express();
app.get('/ssl', (req, res)=>{
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.set('Content-Disposition', 'attachment; filename=node-proxy.pem');
    res.send(fs.readFileSync(path.join(__dirname, 'ca-crt.pem')));
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'node_modules')));
const www = http.Server(app);
const io = require('socket.io')(www);

let index = Date.now();
const handler = (req, res)=>(new Promise((resolve, reject)=>{
    req.on('error', reject);
    req.on('timeout', ()=>reject(new Error('request timeout')));
    const url = require('url').parse(req.url, true);
    if (url.protocol)
        url.port = url.port||80;
    else
    {
        url.protocol = 'https:';
        url.port = url.port||443;
    }
    url.hostname = url.hostname||req.headers.host;
    url.port = +url.port;
    const data = req.data = {
        index: ++index,
        ts: Date.now(),
        req: {
            method: req.method,
            url: `${url.protocol}//${url.hostname}:${url.port}${url.path}`,
            headers: req.headers,
            body: Buffer.alloc(0),
            body_length: 0,
        },
        res: {},
    };
    io.emit('transaction', data);
    const agent = {'http:': http, 'https:': https}[url.protocol];
    req.pipe((new stream.PassThrough()).on('data', chunk=>{
        data.req.body_length += chunk.length;
        if (!argv.limit || data.req.body.length<argv.limit)
            data.req.body = Buffer.concat([data.req.body, chunk]);
    })).pipe(agent.request({
        host: url.hostname,
        port: url.port,
        method: req.method,
        path: url.path,
        headers: req.headers,
        rejectUnauthorized: false,
    }).on('response', _res=>{
        data.res = {
            http: _res.httpVersion,
            code: _res.statusCode,
            msg: _res.statusMessage,
            headers: _res.headers,
            body: Buffer.alloc(0),
            body_length: 0,
        };
        res.writeHead(_res.statusCode, _res.statusMessage, _res.headers);
        _res.on('end', ()=>{
            data.duration = Date.now()-data.ts;
            resolve(data);
        }).on('error', reject);
        let passthrough = new stream.PassThrough();
        _res.pipe(passthrough).pipe(res);
        if (_res.headers['content-encoding']=='gzip')
        {
            const unzip = zlib.createGunzip();
            passthrough.on('data', chunk=>unzip.write(chunk));
            passthrough = unzip;
        }
        passthrough.on('data', chunk=>{
            data.res.body_length += chunk.length;
            if (!argv.limit || data.res.body.length<argv.limit)
                data.res.body = Buffer.concat([data.res.body, chunk]);
        });
    }).on('error', reject));
})).then(data=>{
    io.emit('transaction', data);
}).catch(err=>{
    req.data.duration = Date.now()-req.data.ts;
    io.emit('transaction', req.data);
    console.log('ERROR', `${req.method} ${req.url} - ${err}`);
    if (!res.ended)
        res.writeHead(502, 'Bad Gateway', {Connection: 'close'});
    res.end();
});

(new Promise((resolve, reject)=>{
    const pki = forge.pki;
    const keys = pki.rsa.generateKeyPair(2048);
    const ca = {
        key: pki.privateKeyFromPem(fs.readFileSync(path.join(__dirname, 'ca-key.pem'))),
        cert: fs.readFileSync(path.join(__dirname, 'ca-crt.pem')),
    };
    const issuer = pki.certificateFromPem(ca.cert).issuer;
    const hosts = {};
    https.createServer({
        requestCert: false,
        SNICallback: (name, cb)=>Promise.resolve(hosts[name]).then(ctx=>{
            if (ctx)
                return ctx;
            const cert = pki.createCertificate();
            cert.publicKey = keys.publicKey;
            cert.serialNumber = `${Date.now()}`;
            cert.validity.notBefore = new Date();
            cert.validity.notAfter = new Date();
            cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear()+10);
            cert.setSubject([{name: 'commonName', value: name}]);
            cert.setIssuer(issuer.attributes);
            cert.sign(ca.key, forge.md.sha256.create());
            return hosts[name] = tls.createSecureContext({
                key: pki.privateKeyToPem(keys.privateKey),
                cert: pki.certificateToPem(cert),
                ca: ca.cert,
            });
        }).then(ctx=>cb(null, ctx)).catch(cb),
    }, handler).listen(function(){
        resolve(this);
    }).on('error', reject);
})).then(server=>new Promise((resolve, reject)=>{
    const port = server.address().port;
    http.createServer(handler).on('connect', (req, socket)=>{
        socket.write(`HTTP/1.1 200 OK\r\n\r\n`);
        socket.pipe(net.connect({host: '127.0.0.1', port: port}).on('connect', ()=>{
        }).on('close', ()=>{
        }).on('error', err=>{
            console.log(err);
        })).pipe(socket);
    }).listen(argv.port, function(){
        resolve(this);
    }).on('error', reject);
})).then(server=>{
    console.log(`Proxy is listening on port ${server.address().port}...`);
    return new Promise((resolve, reject)=>{
        www.listen(argv.www, function(){
            resolve(this);
        }).on('error', reject);
    });
}).then(server=>{
    console.log(`Web interface is listening on port ${server.address().port}...`);
}).catch(err=>console.log(err));
