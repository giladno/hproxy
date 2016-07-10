$(function(){
    var socket = io();
    $('#layout').w2layout({
        name: 'layout',
        panels: [
        {type: 'top', size: '32px', style: 'background-color: #F5F6F7; line-height: 32px; '+
            'padding-left: 5px; padding-right: 10px;', content: 'Node Proxy <a href="/ssl" '+
            'style="float: right; position: relative;"><i class="fa fa-unlock"></i></a>'},
        {type: 'left', size: '30%', resizable: true, style: 'background-color: #F5F6F7;'},
        {type: 'main', style: 'background-color: #F5F6F7; padding: 5px;'},
        {type: 'bottom', size: '30%', resizable: true, style: 'background-color: #F5F6F7; padding: 5px;', hidden: true,
            toolbar: {
                items: [
                    {type: 'break', id: 'break'},
                    {type: 'button', id: 'code', icon: 'fa-code fa', checked: true},
                    {type: 'spacer'},
                    {type: 'button', id: 'close', icon: 'fa-close fa'},
                ],
                onClick: function(evt){
                    var toolbar = this;
                    evt.onComplete = function(){
                        if (evt.target=='close')
                            return w2ui.layout.hide('bottom');
                        if (evt.target=='code')
                            return toolbar.set('code', {checked: !evt.item.checked});
                    };
                },
            }},
        ],
    });
    w2ui.layout.content('left', $().w2sidebar({
        name: 'tree',
        onClick: function(evt){
            var entry = evt.object;
            if (!entry || !entry.nodes)
                return;
            w2ui.grid.clear();
            w2ui.grid.add(entry.nodes.map(function(item){
                var data = item.data;
                return {
                    recid: data.index,
                    url: data.req.url,
                    method: data.req.method,
                    code: data.res.code,
                    type: data.res.headers && data.res.headers['content-type'] || '',
                    size: data.res.body_length,
                    duration: data.duration,
                    data: data,
                };
            }));
        },
    }));
    w2ui.layout.content('main', $().w2grid({
        name: 'grid',
        multiSelect: false,
        columns: [
            {field: 'url', caption: 'URL', size: '100%'},
            {field: 'method', caption: 'Method', size: '75px'},
            {field: 'code', caption: 'Status', size: '75px'},
            {field: 'type', caption: 'Type', size: '150px'},
            {field: 'size', caption: 'Size', size: '100px', render: function(rec){
                if (!rec.duration)
                    return '';
                return filesize(rec.size);
            }},
            {field: 'duration', caption: 'Time', size: '75px', render: function(rec){
                if (!rec.duration)
                    return 'pending';
                if (rec.duration<1000)
                    return '<div>'+rec.duration+' ms</div>';
                return '<div>'+(rec.duration/1000).toFixed(2)+' s</div>';
            }},
        ],
        onClick: function(evt){
            var data = this.get(evt.recid).data;
            var toolbar = w2ui.layout.get('bottom').toolbar;
            toolbar.remove('download');
            if(data.res.body && data.res.body.byteLength)
            {
                var URL = window.URL||window.webkitURL;
                toolbar.insert('break', {
                    type: 'button',
                    id: 'download',
                    icon: 'fa-download fa',
                    onClick: function(){
                        var save = $('<a>', {
                            href: URL.createObjectURL(new Blob([data.res.body],
                                      {type: 'application/octet-stream'})),
                            download: data.req.url.split(/[#?]/)[0].split('/').pop()||'file',
                        })[0];
                        var event = document.createEvent('Event');
                        event.initEvent('click', true, true);
                        save.dispatchEvent(event);
                        URL.revokeObjectURL(save.href);
                    },
                });
            }
            var update = function(code){
                var div = $('<div>');
                [data.req, data.res].forEach(function(o){
                    var headers = '';
                    if (o.method)
                        headers = o.method+' '+o.url+' HTTP/'+o.http+'\n';
                    else if (o.code)
                        headers = '\n\nHTTP/'+o.http+' '+o.code+' '+o.msg+'\n';
                    else
                        return;
                    Object.keys(o.headers).forEach(function(name){
                        headers += name+': '+o.headers[name]+'\n';
                    });
                    div.append($('<pre>').text(headers));
                    var type = o.headers['content-type']||'';
                    if (type.match(/application\/x-www-form-urlencoded/) && code)
                    {
                        try {
                            return div.append($('<pre>').text(String.fromCharCode.apply(null,
                                new Uint8Array(o.body)).split('&').map(function(pair){
                                  return pair.split('=').map(decodeURIComponent).join('=');
                            }).join('\n')));
                        } catch(e) {}
                    }
                    if (type.match(/application\/json/) && code)
                    {
                        try {
                            return div.append($('<pre>').text(JSON.stringify(JSON.parse(String.fromCharCode.apply(null,
                                new Uint8Array(o.body))), null, 4)));
                        } catch(e) {}
                    }
                    if (type.match(/^image\//))
                    {
                        try {
                            return div.append($('<img>', {src: 'data:'+type+';base64,'+
                                base64js.fromByteArray(new Uint8Array(o.body))}));
                        } catch(e) {}
                    }
                    if (type.match(/text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|xml$/))
                    {
                        try {
                            return div.append($('<pre>').text(String.fromCharCode.apply(null,
                                new Uint8Array(o.body))));
                        } catch(e) {}
                    }
                });
                w2ui.layout.content('bottom', div.html());
            };
            toolbar.set('code', {onClick: function(evt){
                update(!evt.item.checked);
            }});
            update(toolbar.get('code').checked);
            if (w2ui.layout.get('bottom').hidden)
                w2ui.layout.show('bottom');
        },
    }));
    socket.on('transaction', function(data){
        var url = $('<a>', {href: data.req.url})[0];
        var domain = url.protocol+'//'+url.host;
        if (!w2ui.tree.get(domain))
            w2ui.tree.add({id: domain, text: domain, icon: 'fa fa-globe'});
        var entry = w2ui.tree.get(domain, data.index) || w2ui.tree.add(domain,
            {id: data.index, text: url.pathname, data: data, icon: 'fa fa-angle-right'});
        entry.data = data;
        if (!w2ui.tree.selected)
            return;
        for (entry=w2ui.tree.get(w2ui.tree.selected); entry.parent!=w2ui.tree; entry=entry.parent);
        if (entry.id!=domain)
            return;
        var row = w2ui.grid.get(data.index);
        if (row)
        {
            $.extend(row, {
                code: data.res.code,
                type: data.res.headers && data.res.headers['content-type'] || '',
                size: data.res.body_length,
                duration: data.duration,
                data: data,
            });
            return w2ui.grid.refreshRow(row.recid);
        }
        w2ui.grid.add({
            recid: data.index,
            url: data.req.url,
            method: data.req.method,
            code: data.res.code,
            type: data.res.headers && data.res.headers['content-type'] || '',
            size: data.res.body_length,
            duration: data.duration,
        });
    });
});
