#!/usr/bin/env python3
"""Real HTTP streaming: bounded memory, exact bytes, aborts and cleanup. No GNOME session required."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse

root = Path(tempfile.mkdtemp(prefix='gnome-assistant-stream-test-',dir='/tmp'))
server = subprocess.Popen(['gjs','-m',str(Path(__file__).with_name('stream_attachment_server.js')),str(root)],
                          stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    assert server.stdout.readline().strip() == 'READY', 'Streaming fixture did not start'
    endpoint=json.loads((root/'endpoint.json').read_text())
    url=urllib.parse.urlsplit(endpoint['url'])
    auth={item['name']:item['value'] for item in endpoint['headers']}
    def rpc(action,**args):
        connection=http.client.HTTPConnection(url.hostname,url.port,timeout=15)
        request={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'fixture','arguments':{'action':action,**args}}}
        connection.request('POST',url.path,json.dumps(request),{**auth,'Content-Type':'application/json'})
        response=connection.getresponse();data=json.loads(response.read());connection.close()
        assert response.status==200 and not data['result'].get('isError'), data
        return json.loads(data['result']['content'][0]['text'])
    def start(name,size,headers=None,path='/attachment'):
        connection=http.client.HTTPConnection(url.hostname,url.port,timeout=5)
        connection.putrequest('POST',path)
        for key,value in {**auth,'Content-Length':str(size),'X-Gnome-Filename':urllib.parse.quote(name),**(headers or {})}.items():
            connection.putheader(key,value)
        connection.endheaders()
        return connection
    def idle():
        for _ in range(100):
            state=rpc('stats')
            if state['active']==0:return state
            time.sleep(.05)
        raise AssertionError('Upload did not release its resources')
    def clean():
        state=idle()
        ids={item['id'] for item in state['received']}
        assert {p.name for p in (root/'cache').iterdir()}==ids, 'Incomplete upload directories leaked'
        return state
    def rss():
        for line in Path(f'/proc/{server.pid}/status').read_text().splitlines():
            if line.startswith('VmRSS:'):return int(line.split()[1])*1024
        return 0
    baseline=rss();peak=[baseline];stop=threading.Event()
    def sample():
        while not stop.wait(.005):peak[0]=max(peak[0],rss())
    monitor=threading.Thread(target=sample,daemon=True);monitor.start()
    size=128*1024*1024
    block=bytes(range(256))*256
    digest=hashlib.sha256()
    connection=start('large-video.bin',size)
    for _ in range(size//len(block)):
        connection.send(block);digest.update(block)
    response=connection.getresponse();result=json.loads(response.read());connection.close()
    assert response.status==200 and result['displayed'], result
    state=clean();record=state['received'][0]
    assert not state['accumulated'] and state['bodyLength']==0,'HTTP request bodies are being accumulated'
    assert record['size']==size and state['peakChunk']<=512*1024, state
    source=root/'cache'/record['id']/record['name']
    with source.open('rb') as file:assert hashlib.file_digest(file,'sha256').hexdigest()==digest.hexdigest()
    assert rpc('copy',index=0)['saved']
    with (root/'downloads'/record['name']).open('rb') as file:
        assert hashlib.file_digest(file,'sha256').hexdigest()==digest.hexdigest(), 'Downloaded bytes differ'
    stop.set();monitor.join()
    growth=peak[0]-baseline
    assert growth<48*1024*1024, f'Memory grew by {growth} for a streamed file of {size} bytes'
    # Header validation rejects before receiving a large body.
    for name,length,headers,expected in [('../escape',1,{},400),('too-large',1024**3+1,{},413),
                                       ('denied',1,{'Authorization':'Bearer invalid'},403),
                                       ('origin',1,{'Origin':'https://example.com'},403)]:
        connection=start(name,length,{'Expect':'100-continue',**headers});response=connection.getresponse();response.read();connection.close()
        assert response.status==expected,(name,response.status)
    connection=start('not-inline',32*1024*1024,{'Expect':'100-continue'},path='/mcp')
    response=connection.getresponse();response.read();connection.close()
    assert response.status==413,'Oversized inline MCP bodies were accepted'
    # Disconnection, explicit Stop, timeout, concurrency cap, then server shutdown.
    connection=start('interrupted.bin',32*1024*1024);connection.send(block);connection.close();clean()
    connection=start('cancelled.bin',32*1024*1024);connection.send(block)
    rpc('stop');idle();connection.close();clean();rpc('start')
    connection=start('idle.bin',1024)
    try:
        response=connection.getresponse();response.read();assert response.status==408,response.status
    except (http.client.RemoteDisconnected,ConnectionResetError):pass
    finally:connection.close()
    clean()
    one=start('one.bin',1024);two=start('two.bin',1024)
    for _ in range(40):
        if rpc('stats')['active']==2:break
        time.sleep(.01)
    three=start('three.bin',1024,{'Expect':'100-continue'});response=three.getresponse();response.read();three.close()
    assert response.status==429,response.status
    one.close();two.close();clean()
    # Downloads: the agent streams a file the user attached, with attachment_download.
    def tool(name,arguments):
        connection=http.client.HTTPConnection(url.hostname,url.port,timeout=15)
        request={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':arguments}}
        connection.request('POST',url.path,json.dumps(request),{**auth,'Content-Type':'application/json'})
        response=connection.getresponse();data=json.loads(response.read());connection.close()
        assert response.status==200, data
        return data['result']
    def get(path,headers):
        connection=http.client.HTTPConnection(url.hostname,url.port,timeout=15)
        connection.request('GET',path,headers=headers)
        return connection,connection.getresponse()
    def settled():
        for _ in range(100):
            state=rpc('stats')
            if state['downloading']==0:return state
            time.sleep(.05)
        raise AssertionError('Download did not release its resources')
    size=96*1024*1024
    user_file=root/'user video.bin'
    digest=hashlib.sha256()
    with user_file.open('wb') as file:
        for index in range(size//len(block)):
            chunk=bytes([index%256])+block[1:];file.write(chunk);digest.update(chunk)
    offer=rpc('offer',path=str(user_file))
    result=tool('attachment_download',{'id':offer['id']})
    assert not result.get('isError'),result
    info=json.loads(result['content'][0]['text'])
    assert info['size']==size and info['method']=='GET' and info['filename']=='user video.bin',info
    download_path=urllib.parse.urlsplit(info['url']).path
    baseline=rss();peak=[baseline];stop=threading.Event()
    monitor=threading.Thread(target=sample,daemon=True);monitor.start()
    connection,response=get(download_path,info['headers'])
    assert response.status==200 and int(response.getheader('Content-Length'))==size,response.status
    received_digest=hashlib.sha256();total=0
    while chunk:=response.read(1024*1024):received_digest.update(chunk);total+=len(chunk)
    connection.close();stop.set();monitor.join()
    assert total==size and received_digest.hexdigest()==digest.hexdigest(),'Downloaded bytes differ from the attached file'
    growth=peak[0]-baseline
    assert growth<48*1024*1024,f'Memory grew by {growth} while streaming a {size} byte download'
    state=settled();assert state['downloads'][-1]=={'ok':True,'error':None},state['downloads']
    download_growth=growth
    # Refusals: unknown id, bad token, wrong method, no active turn.
    for path,headers,expected in [('/download/unknown',info['headers'],404),(download_path,{'Authorization':'Bearer invalid'},403),
                                 (download_path,{**info['headers'],'Origin':'https://example.com'},403)]:
        connection,response=get(path,headers);response.read();connection.close()
        assert response.status==expected,(path,response.status)
    connection=http.client.HTTPConnection(url.hostname,url.port,timeout=5)
    connection.request('POST',download_path,b'',{**info['headers'],'Content-Length':'0'});response=connection.getresponse();response.read();connection.close()
    assert response.status==405,response.status
    rpc('stop')
    assert tool('attachment_download',{'id':offer['id']}).get('isError'),'Downloads were offered outside a turn'
    connection,response=get(download_path,info['headers']);response.read();connection.close()
    assert response.status==404,response.status
    rpc('start')
    # An interrupted download, then an idle client, release their resources.
    connection,response=get(download_path,info['headers']);response.read(1024*1024);connection.close()
    state=settled();assert state['downloads'][-1]['ok'] is False,state['downloads']
    connection,response=get(download_path,info['headers'])
    time.sleep(2.5)
    state=settled();assert 'timed out' in (state['downloads'][-1]['error'] or ''),state['downloads']
    connection.close()
    # At most two downloads at once.
    first=get(download_path,info['headers']);second=get(download_path,info['headers'])
    connection,response=get(download_path,info['headers']);response.read();connection.close()
    assert response.status==429,response.status
    first[0].close();second[0].close();settled()
    # A folder is streamed as one tar archive of exactly the promised size.
    import tarfile
    folder=root/'project';(folder/'src'/'deep').mkdir(parents=True)
    folder_digests={}
    for index in range(40):
        name=f'src/deep/part-{index:02}.bin' if index%2 else f'src/file {index:02}.txt'
        data=bytes([index])*(1024*1024+index)
        (folder/name).write_bytes(data);folder_digests['project/'+name]=hashlib.sha256(data).hexdigest()
    (folder/('long-'+'n'*150+'.txt')).write_text('long name')
    folder_digests['project/long-'+'n'*150+'.txt']=hashlib.sha256(b'long name').hexdigest()
    # GNU tar (default, chunked) and the built-in writer (exact Content-Length).
    folder_growth=0
    for builtin in [False,True]:
        offer=rpc('offer',path=str(folder),folder=True,builtin=builtin)
        info=json.loads(tool('attachment_download',{'id':offer['id']})['content'][0]['text'])
        assert info['filename']=='project.tar' and info['format']=='tar' and info['files']==41,info
        baseline=rss();peak=[baseline];stop=threading.Event()
        monitor=threading.Thread(target=sample,daemon=True);monitor.start()
        connection,response=get(urllib.parse.urlsplit(info['url']).path,info['headers'])
        assert response.status==200 and response.getheader('Content-Type')=='application/x-tar',response.status
        if builtin:
            assert int(response.getheader('Content-Length'))==offer['size'],'The built-in archive size changed'
        else:
            assert response.getheader('Transfer-Encoding')=='chunked','The GNU tar archive was not chunked'
        seen={}
        with tarfile.open(fileobj=response,mode='r|') as archive:
            for member in archive:
                if member.isfile():seen[member.name]=hashlib.sha256(archive.extractfile(member).read()).hexdigest()
        connection.close();stop.set();monitor.join()
        assert seen==folder_digests,f'The folder archive differs from the folder (builtin={builtin})'
        folder_growth=max(folder_growth,peak[0]-baseline)
        assert peak[0]-baseline<48*1024*1024,f'Memory grew by {peak[0]-baseline} while streaming a folder (builtin={builtin})'
        state=settled();assert state['downloads'][-1]=={'ok':True,'error':None},state['downloads']
    # Editing a file in the folder: GNU tar refuses before streaming (409),
    # the built-in writer stops the transfer early.
    tar_offer=rpc('offer',path=str(folder),folder=True)
    tar_info=json.loads(tool('attachment_download',{'id':tar_offer['id']})['content'][0]['text'])
    time.sleep(.02);(folder/'src'/'file 00.txt').write_bytes(b'edited')
    connection,response=get(urllib.parse.urlsplit(tar_info['url']).path,tar_info['headers'])
    body=json.loads(response.read());connection.close()
    assert response.status==409 and 'changed' in body['error'],(response.status,body)
    connection,response=get(urllib.parse.urlsplit(info['url']).path,info['headers'])
    try:
        received=len(response.read())
    except http.client.IncompleteRead as error:
        received=len(error.partial)
    connection.close()
    assert received<offer['size'],'An edited folder was streamed completely'
    state=settled();assert state['downloads'][-1]['ok'] is False and 'changed' in state['downloads'][-1]['error'],state['downloads']
    # The agent gets the file as attached: a changed file is refused.
    with user_file.open('ab') as file:file.write(b'edited')
    connection,response=get(download_path,info['headers']);body=json.loads(response.read());connection.close()
    assert response.status==409 and 'changed' in body['error'],(response.status,body)
    pending=start('shutdown.bin',1024);pending.send(b'x')
    rpc('close');server.wait(timeout=5);pending.close()
    assert server.returncode==0,server.stderr.read()
    assert {p.name for p in (root/'cache').iterdir()}=={record['id']},'Server shutdown left a partial upload'
    assert not list((root/'downloads').glob('*.part')),'Download left temporary files'
    errors=server.stderr.read()
    assert 'JS ERROR' not in errors and 'CRITICAL' not in errors,errors
    print(f'STREAMING TESTS PASSED: 128 MiB upload and download; 96 MiB attachment download, RSS growth '
          f'{download_growth/1024/1024:.1f} MiB; 40 MiB folder archive, RSS growth {folder_growth/1024/1024:.1f} MiB; '
          'refusals, timeouts and cleanup verified.')
finally:
    if server.poll() is None:server.terminate();server.wait(timeout=5)
    shutil.rmtree(root)
