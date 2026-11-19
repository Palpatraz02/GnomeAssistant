#!/usr/bin/env python3
"""Local ACP fixture for native A2UI integration tests; no external agent calls."""
import json
import base64
import hashlib
import tarfile
import io
import http.client
import os
import sys
import time
import urllib.request
import urllib.parse
import zipfile

CATALOG = 'urn:gnome-assistant:a2ui:catalog:1'
use_tools = '--no-tools' not in sys.argv
model_value = 'quick'
effort_value = 'low'

def config_options():
    # Non-provider IDs, grouped models and effort preceding model exercise ACP metadata.
    return [
        {'id': 'depth-choice', 'name': 'Thinking effort', 'category': 'thought_level',
         'type': 'select', 'currentValue': effort_value,
         'options': [{'name': value.title(), 'value': value}
                     for value in (['low', 'high'] if model_value == 'deep' else ['low', 'normal'])]},
        {'id': 'engine-choice', 'name': 'Model', 'category': 'model', 'type': 'select',
         'currentValue': model_value, 'options': [{'group': 'family', 'name': 'Test models',
          'options': [{'name': value.title(), 'value': value} for value in ['quick', 'deep', 'rejected']]}]},
        {'id': 'generic-option', 'name': 'Other setting', 'type': 'select', 'currentValue': 'one',
         'options': [{'name': 'One', 'value': 'one'}]},
    ]

def send(**data):
    print(json.dumps({'jsonrpc': '2.0', **data}), flush=True)

def chunk(content):
    send(method='session/update', params={'sessionId': 'a2ui-test', 'update': {
        'sessionUpdate': 'agent_message_chunk', 'content': content}})

def text(value):
    chunk({'type': 'text', 'text': value})

def mcp(name, arguments):
    request = urllib.request.Request(server['url'], data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': name, 'arguments': arguments}}).encode(), headers={
            **{header['name']: header['value'] for header in server['headers']},
            'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(request, timeout=5))['result']

def call(function_name, **args):
    return {'@call': function_name, 'args': args}

def binding(path):
    return {'@path': path}

def local_ui():
    is_f = call('compare', left=binding('/unit'), right='f', operator='eq')
    number = call('number', value=binding('/c'), fallback=0)
    temperature = call('if', condition=is_f,
        then=call('add', values=[call('divide', left=call('multiply', values=[number, 9]), right=5), 32]),
        **{'else': number})
    valid = {'condition': call('and', values=[call('required',value=binding('/c')),call('numeric', value=binding('/c'), min=0, max=100)]), 'message': 'Enter a number from 0 to 100.'}
    selected = call('filter', items=binding('/items'), predicate=call('includes', value=binding('name'), search=binding('/query'), caseSensitive=False))
    return {'version': '1.0', 'createSurface': {'surfaceId': 'local', 'catalogId': CATALOG,
        'sendDataModel': True, 'dataModel': {'c': '20', 'unit': 'c', 'query': '', 'divisor': 0,
            'items': [{'name': 'Alpha', 'score': 1}, {'name': 'Beta', 'score': 3}, {'name': 'Gamma', 'score': 2}],
            'shown': [{'name': 'Alpha', 'score': 1}, {'name': 'Beta', 'score': 3}, {'name': 'Gamma', 'score': 2}]},
        'components': [
            {'id': 'root', 'component': 'Card', 'child': 'body'},
            {'id': 'body', 'component': 'Column', 'children': ['title', 'c', 'temperature', 'toggle', 'query', 'apply', 'list', 'bad', 'fix', 'submit']},
            {'id': 'title', 'component': 'Text', 'variant': 'h2', 'text': 'Instant local interactions'},
            {'id': 'c', 'component': 'TextField', 'label': 'Value', 'value': binding('/c'), '@checks': [valid]},
            {'id': 'temperature', 'component': 'Text', 'text': call('concat', values=[
                call('formatNumber', value=temperature, decimals=0, locale='en-US'),
                call('if', condition=is_f, then=' °F', **{'else': ' °C'})])},
            {'id': 'toggle', 'component': 'Button', 'child': 'toggleLabel', 'action': {'functionCall': call('setValue', path='/unit',
                value=call('if', condition=is_f, then='c', **{'else': 'f'}))}},
            {'id': 'toggleLabel', 'component': 'Text', 'text': call('if', condition=is_f, then='Show Celsius', **{'else': 'Show Fahrenheit'})},
            {'id': 'query', 'component': 'TextField', 'label': 'Filter list', 'value': binding('/query')},
            {'id': 'apply', 'component': 'Button', 'child': 'applyLabel', 'action': {'functionCall': call('sequence', steps=[
                call('setValue', path='/shown', value=call('sort', items=selected, key='/score', direction='descending'))])}},
            {'id': 'applyLabel', 'component': 'Text', 'text': 'Filter and sort'},
            {'id': 'list', 'component': 'List', 'children': {'componentId': 'row', 'path': '/shown'}},
            {'id': 'row', 'component': 'Text', 'text': call('concat', values=[call('@index', offset=1), '. ', binding('name')])},
            {'id': 'bad', 'component': 'Text', 'text': call('concat', values=['Result: ', call('divide', left=1, right=binding('/divisor'))])},
            {'id': 'fix', 'component': 'Button', 'child': 'fixLabel', 'action': {'functionCall': call('setValue', path='/divisor', value=2)}},
            {'id': 'fixLabel', 'component': 'Text', 'text': 'Fix calculation'},
            {'id': 'submit', 'component': 'Button', 'child': 'submitLabel', '@checks': [valid], 'action': {'event': {'name': 'local_submit'}}},
            {'id': 'submitLabel', 'component': 'Text', 'text': 'Submit valid value'},
        ]}}

def remote_ui():
    lookup=call('lookupTitle', name=binding('/name'))
    title=call('get', value=lookup, path='/text')
    validation={'condition':call('validateName', name=binding('/name')), 'message':'Choose another name.'}
    return {'version':'1.0','createSurface':{'surfaceId':'remote','catalogId':CATALOG,'sendDataModel':True,
        'dataModel':{'name':'Alice','counter':0,'summary':'','selection':['one']},'components':[
            {'id':'root','component':'Card','child':'body'},
            {'id':'body','component':'Column','children':['heading','name','answer','echo','choices','summary','counter','refresh','submit']},
            {'id':'heading','component':'Text','variant':'h2','text':'Agent-backed information'},
            {'id':'name','component':'TextField','label':'Name','value':binding('/name'),'@checks':[validation]},
            {'id':'answer','component':'Text','text':title},
            {'id':'echo','component':'Text','text':call('concat',values=['Echo: ',title])},
            {'id':'choices','component':'ChoicePicker','label':'Agent choices','value':binding('/selection'),'options':call('listChoices',name=binding('/name'))},
            {'id':'summary','component':'Text','text':binding('/summary')},
            {'id':'counter','component':'Text','text':call('concat',values=['Completed steps: ',binding('/counter')])},
            {'id':'refresh','component':'Button','child':'refreshLabel','action':{'functionCall':call('sequence',steps=[
                call('setValue',path='/counter',value=call('add',values=[binding('/counter'),1])),
                call('setValue',path='/summary',value=call('makeSummary',name=binding('/name'))),
                call('setValue',path='/counter',value=call('add',values=[binding('/counter'),1])),
            ])}},
            {'id':'refreshLabel','component':'Text','text':'Ask agent for a summary'},
            {'id':'submit','component':'Button','child':'submitLabel','@checks':[validation],'action':{'event':{'name':'submit_remote'}}},
            {'id':'submitLabel','component':'Text','text':'Continue'},
        ]}}

def components_ui():
    root=os.environ['GNOME_ASSISTANT_TEST_ROOT']+'/workspace/'
    return {'version':'1.0','createSurface':{'surfaceId':'components','catalogId':CATALOG,
        'dataModel':{'amount':3,'date':'2026-11-14','time':'12:30','selection':[]},'components':[
            {'id':'root','component':'Column','children':['title','tabs','modal','audio','video']},
            {'id':'title','component':'Text','variant':'h2','text':'Native component gallery'},
            {'id':'tabs','component':'Tabs','tabs':[{'title':'Inputs','child':'inputs'},{'title':'Formatting','child':'formatting'}]},
            {'id':'inputs','component':'Column','children':['slider','date','time','computed','choiceFilter','standardIcon','svgIcon']},
            {'id':'slider','component':'Slider','label':'Amount','min':0,'max':10,'steps':10,'value':binding('/amount')},
            {'id':'date','component':'DateTimeInput','label':'Date','enableDate':True,'value':binding('/date'),'min':'2026-01-01','max':'2026-12-31'},
            {'id':'time','component':'DateTimeInput','label':'Time','enableTime':True,'value':binding('/time')},
            {'id':'choiceFilter','component':'ChoicePicker','filterable':True,'displayStyle':'checkbox','value':binding('/selection'),'options':[{'label':'First','value':'one'},{'label':'Second','value':'two'}]},
            {'id':'standardIcon','component':'Icon','name':'search'},
            {'id':'svgIcon','component':'Icon','name':{'svgPath':'M2 2h20v20H2z'}},
            {'id':'computed','component':'Text','text':call('formatString',value='Value: ${formatNumber(value:${/amount}, decimals:1, grouping:false)}')},
            {'id':'formatting','component':'Column','children':['money','day','plural','email']},
            {'id':'money','component':'Text','text':call('formatCurrency',value=binding('/amount'),currency='EUR',locale='en-US',decimals=2)},
            {'id':'day','component':'Text','text':call('formatDate',value=binding('/date'),format='EEEE, d MMMM yyyy',locale='en-US')},
            {'id':'plural','component':'Text','text':call('pluralize',value=binding('/amount'),one='item',other='items',locale='en-US')},
            {'id':'email','component':'TextField','label':'Email','value':'person@example.com','@checks':[{'condition':call('email',value='person@example.com')}]},
            {'id':'modal','component':'Modal','trigger':'details','content':'modalText'},
            {'id':'details','component':'Button','child':'detailsLabel','action':{'event':{'name':'unused'}}},
            {'id':'detailsLabel','component':'Text','text':'Open details'},
            {'id':'modalText','component':'Text','text':'**Native dialog** with formatted text.'},
            {'id':'audio','component':'AudioPlayer','url':root+'tone.wav','description':'Local audio'},
            {'id':'video','component':'Video','url':root+'video.webm','posterUrl':root+'preview.png'},
        ]}}

def rpc_requests():
    return [{'version': '1.0', 'callRendererFunction': {'functionCallId': name, 'surfaceId': 'local',
        'callFunction': {**function, 'catalogId': CATALOG}}} for name, function in [
            ('calc', call('multiply', values=[call('number', value=binding('/c')), 2])),
            ('denied', call('setValue', path='/unit', value='x'))]]

pending = None
loop_mode = False
stop_mode = False
for line in sys.stdin:
    message = json.loads(line)
    params = message.get('params', {})
    method = message.get('method')
    if method == 'initialize':
        assert params['clientCapabilities']['_meta']['org.gnome.assistant/a2ui']['version'] == '1.0'
        send(id=message['id'], result={'protocolVersion': 1, 'agentCapabilities': {
            'loadSession': True, 'mcpCapabilities': {'http': use_tools},
            'promptCapabilities': {'embeddedContext': True, 'image': True}}})
    elif method in ['session/new', 'session/load']:
        model_value, effort_value = 'quick', 'low'
        server = params['mcpServers'][0] if use_tools else None
        send(method='session/update', params={'sessionId': 'a2ui-test', 'update': {
            'sessionUpdate': 'available_commands_update',
            'availableCommands': [{'name': 'native', 'description': 'Native command'}]}})
        send(id=message['id'], result={'sessionId': 'a2ui-test', 'configOptions': config_options()})
    elif method == 'session/set_config_option':
        config_id, value = params['configId'], params['value']
        with open(os.environ['GNOME_ASSISTANT_TEST_ROOT']+'/config-requests.jsonl', 'a') as log:
            log.write(json.dumps(params)+'\n')
        option = next(item for item in config_options() if item['id'] == config_id)
        values = [choice['value'] for group in option['options'] for choice in group.get('options', [group])]
        if value not in values or value == 'rejected':
            send(id=message['id'], error={'code': -32602, 'message': 'Test selection rejected.'})
            continue
        if config_id == 'engine-choice':
            model_value, effort_value = value, 'low'
        elif config_id == 'depth-choice':
            effort_value = value
        send(method='session/update', params={'sessionId': 'a2ui-test', 'update': {
            'sessionUpdate': 'config_option_update', 'configOptions': config_options()}})
        send(id=message['id'], result={'configOptions': config_options()})
    elif method == 'session/prompt':
        value = params['prompt'][0]['text']
        capabilities = params['_meta']['org.gnome.assistant/a2ui']['a2uiRendererCapabilities']['1.0']
        assert capabilities['supportedCatalogIds'] == [CATALOG]
        delivery = params['_meta']['org.gnome.assistant/a2ui']['transport']
        assert delivery['preferred'] == ('mcp' if use_tools else 'acp')
        assert delivery['rendererFunctionResults'] == ('tool-result' if use_tools else 'following-prompt')
        expected = 'A2UI delivery for this connection: prefer MCP.' if use_tools else 'A2UI delivery for this connection: MCP is unavailable.'
        assert any(expected in block.get('text', '') for block in params['prompt'])
        if not use_tools:
            assert any('GNOME A2UI reference (documentation' in block.get('text', '') for block in params['prompt'])
            assert not any('"$defs"' in block.get('text', '') for block in params['prompt'])
        if value.startswith('{') and 'callAgentFunction' in json.loads(value.splitlines()[0]):
            requests=[json.loads(line)['callAgentFunction'] for line in value.splitlines()]
            replies=[]
            for request in requests:
                function=request['callFunction']; args=function.get('args',{}); name=function['@call']
                mode=params['_meta']['org.gnome.assistant/a2ui']['agentFunctionModes'][request['functionCallId']]
                assert function['catalogId']==CATALOG
                with open(os.environ['GNOME_ASSISTANT_TEST_ROOT']+'/agent-functions.jsonl','a') as log:
                    log.write(json.dumps({'name':name,'args':args,'mode':mode,'id':request['functionCallId']})+'\n')
                response={'functionCallId':request['functionCallId']}
                if args.get('name') in ['hold','timeout']:
                    pending=message['id']
                    break
                if name=='lookupTitle':
                    assert mode=='reactive'
                    if args['name']=='bad': response['error']={'code':'LOOKUP_FAILED','message':'Lookup failed.'}
                    elif args['name']=='missing': continue
                    else: response['value']={'text':'Hello '+args['name']}
                elif name=='contextValue':
                    assert mode=='action'
                    response['value']='resolved context'
                elif name=='listChoices':
                    assert mode=='reactive'
                    response['value']=[{'label':args['name']+' one','value':'one'},{'label':args['name']+' two','value':'two'}]
                elif name=='validateName':
                    assert mode=='reactive'
                    response['value']={'valid':args['name']!='bad'}
                elif name=='makeSummary':
                    assert mode=='action'
                    response['value']='Summary for '+args['name']
                else:
                    response['error']={'code':'UNKNOWN_FUNCTION','message':'Unknown test function.'}
                replies.append({'version':'1.0','agentFunctionResponse':response})
            else:
                if any(request['callFunction']['@call']=='makeSummary' for request in requests):
                    function_pending=(message['id'],replies)
                    send(id='function-approve',method='session/request_permission',params={'sessionId':'a2ui-test',
                        'toolCall':{'kind':'other','title':'Approve interface action'},'options':[
                            {'kind':'allow_once','optionId':'once'},{'kind':'reject_once','optionId':'reject'}]})
                    continue
                if replies:
                    if use_tools:
                        result=mcp('render_a2ui',{'messages':replies}); assert not result.get('isError'),result
                    else: text('```a2ui\n'+json.dumps(replies)+'\n```')
                send(id=message['id'],result={'stopReason':'end_turn'})
            continue
        if not value.startswith('{'):
            loop_mode = value == 'rpc-loop'
            stop_mode = value == 'rpc-stop'
        if value == 'configuration':
            text(model_value + ':' + effort_value)
        elif value == 'files':
            result=mcp('send_attachment',{'filename':'report.txt','text':'Risultato: caffè ☕\n'})
            assert not result.get('isError'),result
            zipped=io.BytesIO()
            with zipfile.ZipFile(zipped,'w'):
                pass
            result=mcp('send_attachment',{'filename':'results.zip','base64':base64.b64encode(zipped.getvalue()).decode()})
            assert not result.get('isError'),result
            upload=json.loads(mcp('attachment_upload',{})['content'][0]['text'])
            raw=b'\x00\xff\x01\x00\x80\xfe'
            request=urllib.request.Request(upload['url'],data=raw,method=upload['method'],headers={
                **upload['headers'],upload['filenameHeader']:urllib.parse.quote('data.bin'),
                'Content-Length':str(len(raw))})
            with urllib.request.urlopen(request,timeout=5) as result:
                assert json.load(result)['displayed']
            for args in [{'filename':'x.txt','text':'x','base64':'eA=='},{'filename':'../escape','text':'x'}]:
                assert mcp('send_attachment',args).get('isError')
        elif value == 'files-acp':
            chunk({'type':'resource','resource':{'uri':'attachment:///fallback.csv',
                'mimeType':'text/csv','text':'name,value\nexample,42\n'}})
        elif value in ['large-file','large-file-cancel']:
            upload=json.loads(mcp('attachment_upload',{})['content'][0]['text'])
            endpoint=urllib.parse.urlsplit(upload['url'])
            connection=http.client.HTTPConnection(endpoint.hostname,endpoint.port,timeout=5)
            size=16*1024*1024
            block=bytes(range(256))*256
            cancelled=False
            try:
                connection.putrequest('POST',endpoint.path)
                for key,header in {**upload['headers'],'Content-Length':str(size),'X-Gnome-Filename':'large-transfer.bin'}.items():
                    connection.putheader(key,header)
                connection.endheaders()
                for _ in range(size//len(block)):
                    connection.send(block);time.sleep(.004)
                response=connection.getresponse();result=response.read()
                if response.status!=200:
                    cancelled=True
                else:
                    assert json.loads(result)['displayed']
            except (BrokenPipeError,ConnectionResetError,http.client.RemoteDisconnected):
                cancelled=True
            finally:
                connection.close()
            assert cancelled == (value=='large-file-cancel')
            if cancelled:text('Transfer cancelled.')
        elif value.startswith('Please download the attached file.'):
            # Large user files are offered for download instead of embedded.
            assert all(block['type'] == 'text' for block in params['prompt']), 'A large attachment was embedded'
            line = next(line for line in value.splitlines() if line.startswith('Attached file for download: '))
            offer = json.loads(line[len('Attached file for download: '):].rstrip('.'))
            assert mcp('attachment_download', {'id': 'unknown'}).get('isError'), 'An unknown attachment id was accepted'
            download = json.loads(mcp('attachment_download', {'id': offer['id']})['content'][0]['text'])
            endpoint = urllib.parse.urlsplit(download['url'])
            connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=5)
            connection.request(download['method'], endpoint.path, headers=download['headers'])
            response = connection.getresponse()
            assert response.status == 200, response.status
            digest = hashlib.sha256(); size = 0
            while piece := response.read(1024 * 1024):
                digest.update(piece); size += len(piece)
            connection.close()
            assert size == offer['size'] == download['size'], (size, offer, download)
            text(f"Downloaded {offer['name']}: {size} bytes, sha256 {digest.hexdigest()}")
        elif value.startswith('Please download the attached folder.'):
            line = next(line for line in value.splitlines() if line.startswith('Attached folder for download: '))
            offer = json.loads(line[len('Attached folder for download: '):].rstrip('.'))
            assert offer['format'] == 'tar' and offer['files'] == 2, offer
            download = json.loads(mcp('attachment_download', {'id': offer['id']})['content'][0]['text'])
            assert download['filename'] == 'project.tar' and download['format'] == 'tar', download
            endpoint = urllib.parse.urlsplit(download['url'])
            connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=5)
            connection.request(download['method'], endpoint.path, headers=download['headers'])
            response = connection.getresponse()
            assert response.status == 200, response.status
            with tarfile.open(fileobj=response, mode='r|') as archive:
                names = sorted(member.name for member in archive if member.isfile())
            connection.close()
            text('Extracted project: ' + ', '.join(names))
        elif value in ('tool-between', 'tool-between-spaced'):
            # Text, a tool call, then more text: one stream that needs a break.
            text("I'll create hello.txt and verify its contents.")
            send(method='session/update', params={'sessionId': 'a2ui-test', 'update': {
                'sessionUpdate': 'tool_call', 'toolCallId': 'write-1', 'title': 'Write hello.txt',
                'kind': 'edit', 'status': 'in_progress'}})
            send(method='session/update', params={'sessionId': 'a2ui-test', 'update': {
                'sessionUpdate': 'tool_call_update', 'toolCallId': 'write-1', 'status': 'completed'}})
            text('\nCreated hello.txt.' if value == 'tool-between-spaced' else 'Created hello.txt.')
            text(' It contains hello world.')
        elif value.startswith('context-echo'):
            # The written context blocks and the number of images that arrived.
            text(json.dumps({'prompt': value, 'images': sum(block['type'] == 'image' for block in params['prompt']),
                'texts': [block['text'] for block in params['prompt'][1:]
                    if block['type'] == 'text' and ' context snapshot: ' in block['text'][:40]],
                'window_instructions': any('window menu' in block.get('text', '') for block in params['prompt'])}))
        elif value.startswith('privacy-echo'):
            # Echo exactly what arrived, so tests check what left the extension.
            text(json.dumps({'prompt': value, 'resources': [block['resource'].get('text', '')
                for block in params['prompt'] if block['type'] == 'resource']}))
        elif value.startswith('Please review the attached file.'):
            assert params['prompt'][1]['type'] == 'image' and params['prompt'][1]['mimeType'] == 'image/png'
            assert 'Attached file: "preview.png".' in value
            text('Attachment received.')
        elif value == 'progressive':
            result=mcp('render_a2ui', {'messages':[{'version':'1.0','createSurface':{
                'surfaceId':'progressive','catalogId':CATALOG,'dataModel':{'status':'Loading…'},'components':[
                    {'id':'root','component':'Text','text':{'@path':'/status'}}]}}]})
            assert not result.get('isError'),result
            time.sleep(.6)
            result=mcp('render_a2ui', {'messages':[{'version':'1.0','updateDataModel':{
                'surfaceId':'progressive','path':'/status','value':'Ready'}}]})
            assert not result.get('isError'),result
        elif value == 'progressive-clear':
            mcp('render_a2ui', {'messages':[{'version':'1.0','deleteSurface':{'surfaceId':'progressive'}}]})
        elif value == 'form':
            catalog = json.loads(mcp('get_a2ui_catalog', {})['content'][0]['text'])
            assert catalog['catalogId'] == CATALOG
            assert catalog['kind'] == 'a2ui-agent-reference' and '$defs' not in catalog
            assert len(json.dumps(catalog)) < 8000
            selected=json.loads(mcp('get_a2ui_catalog', {'components':['Text'],'functions':['openUrl']})['content'][0]['text'])
            assert list(selected['components']) == ['Text'] and list(selected['functions']) == ['openUrl']
            assert mcp('get_a2ui_catalog', {'components':['WebView']}).get('isError')
            schema=json.loads(mcp('get_a2ui_catalog', {'format':'schema'})['content'][0]['text'])
            assert schema['$id'] == CATALOG and '$defs' in schema
            components = [
                {'id': 'root', 'component': 'Card', 'child': 'body'},
                {'id': 'body', 'component': 'Column', 'children': [
                    'heading', 'divider', 'name', 'echo', 'notes', 'password', 'check', 'choice', 'list', 'submit']},
                {'id': 'heading', 'component': 'Row', 'children': ['icon', 'title']},
                {'id': 'icon', 'component': 'Icon', 'name': 'weather-clear-symbolic'},
                {'id': 'title', 'component': 'Text', 'text': 'Plan your day', 'variant': 'h2'},
                {'id': 'divider', 'component': 'Divider'},
                {'id': 'name', 'component': 'TextField', 'label': 'Name', 'value': {'@path': '/name'}},
                {'id': 'echo', 'component': 'Text', 'text': {'@path': '/name'}},
                {'id': 'notes', 'component': 'TextField', 'label': 'Notes', 'variant': 'longText', 'value': {'@path': '/notes'}},
                {'id': 'password', 'component': 'TextField', 'label': 'Private input', 'variant': 'obscured', 'value': {'@path': '/password'}},
                {'id': 'check', 'component': 'CheckBox', 'label': 'Include tomorrow', 'value': {'@path': '/tomorrow'}},
                {'id': 'choice', 'component': 'ChoicePicker', 'label': 'Units', 'value': {'@path': '/units'}, 'options': [
                    {'label': 'Celsius', 'value': 'c'}, {'label': 'Fahrenheit', 'value': 'f'}]},
                {'id': 'list', 'component': 'List', 'children': {'componentId': 'day', 'path': '/days'}},
                {'id': 'day', 'component': 'Text', 'text': {'@path': 'label'}},
                {'id': 'submit', 'component': 'Button', 'variant': 'primary', 'child': 'submitText', 'action': {'event': {
                    'name': 'submit', 'userMessage': 'Update my plan', 'context': {
                        'name': {'@path': '/name'}, 'tomorrow': {'@path': '/tomorrow'}, 'units': {'@path': '/units'}}}}},
                {'id': 'submitText', 'component': 'Text', 'text': 'Update plan'},
            ]
            payload = json.dumps({'version': '1.0', 'createSurface': {'surfaceId': 'form', 'catalogId': CATALOG,
                'sendDataModel': True, 'components': components, 'dataModel': {
                    'name': 'Alice', 'notes': '', 'password': '', 'tomorrow': False, 'units': ['c'],
                    'days': [{'label': 'Today: sunny'}, {'label': 'Tomorrow: cloudy'}]}}})
            text('Here is your plan.\n```a2ui\n' + payload[:100])
            text(payload[100:] + '\n```')
        elif value.startswith('{') and 'rendererFunctionResponse' in json.loads(value.splitlines()[0]):
            responses = [json.loads(line)['rendererFunctionResponse'] for line in value.splitlines()]
            assert responses[0] == {'functionCallId': 'calc', 'value': 50}, responses
            assert responses[1]['functionCallId'] == 'denied' and responses[1]['error']['code'] == 'INVALID_FUNCTION_CALL', responses
            if stop_mode:
                pending = message['id']
                continue
            if loop_mode:
                text('```a2ui\n' + json.dumps(rpc_requests()) + '\n```')
            else:
                text('Function results received.')
        elif value == 'remote':
            text('Original response.\n```a2ui\n'+json.dumps(remote_ui())+'\n```')
        elif value == 'components':
            text('```a2ui\n'+json.dumps(components_ui())+'\n```')
        elif value == 'local':
            text('```a2ui\n' + json.dumps(local_ui()) + '\n```')
        elif value in ['rpc', 'rpc-loop', 'rpc-stop']:
            text('```a2ui\n' + json.dumps(rpc_requests()) + '\n```')
        elif value == 'rpc-mcp':
            result = mcp('render_a2ui', {'messages': rpc_requests()})
            assert not result.get('isError'), result
            result = json.loads(result['content'][0]['text'])
            assert result['responses'][0]['rendererFunctionResponse']['value'] == 50, result
            assert result['responses'][1]['rendererFunctionResponse']['error']['code'] == 'INVALID_FUNCTION_CALL', result
            text('MCP function results received.')
        elif value.startswith('{') and json.loads(value).get('action',{}).get('name')=='contextSubmit':
            assert json.loads(value)['action']['context']['value']=='resolved context'
            text('Context event received.')
        elif value.startswith('{'):
            event = json.loads(value)
            assert event['version'] == '1.0'
            assert event['action']['name'] == 'submit'
            assert event['action']['context'] == {'name': 'Jane', 'tomorrow': True, 'units': ['f']}
            models = params['_meta']['org.gnome.assistant/a2ui']['a2uiClientDataModel']['surfaces']
            assert models['form']['name'] == 'Jane'
            assert any('A2UI client data models:' in block.get('text', '') for block in params['prompt'])
            result = mcp('render_a2ui', {'messages': [{'version': '1.0', 'updateDataModel': {
                'surfaceId': 'form', 'path': '/name', 'value': 'Updated'}}]})
            assert not result.get('isError'), result
            text('Plan updated.')
        elif value in ['resource', 'Display an interactive A2UI interface for this request.\nresource']:
            chunk({'type': 'resource', 'resource': {'uri': 'gnome-assistant://ui/resource',
                'mimeType': 'application/a2ui+json', 'text': json.dumps({'version': '1.0', 'createSurface': {
                    'surfaceId': 'resource', 'catalogId': CATALOG, 'components': [
                        {'id': 'root', 'component': 'Column', 'children': ['caption', 'image']},
                        {'id': 'caption', 'component': 'Text', 'text': 'Resource interface'},
                        {'id': 'image', 'component': 'Image', 'description': 'Local preview',
                         'url': os.environ['GNOME_ASSISTANT_TEST_ROOT'] + '/workspace/preview.png'}]}})}})
        elif value == 'invalid':
            result = mcp('render_a2ui', {'messages': [{'version': '1.0', 'updateComponents': {
                'surfaceId': 'form', 'components': [{'id': 'root', 'component': 'WebView'}]}}]})
            assert result.get('isError'), result
            text('Invalid interface rejected.')
        elif value == 'clear':
            for surface_id in ['form', 'resource']:
                result = mcp('render_a2ui', {'messages': [{'version': '1.0', 'deleteSurface': {'surfaceId': surface_id}}]})
                assert not result.get('isError'), result
        elif value == 'approval':
            pending = message['id']
            send(id='approve', method='session/request_permission', params={'sessionId': 'a2ui-test',
                'toolCall': {'kind': 'other', 'title': 'Sample approval'}, 'options': [
                    {'kind': 'allow_once', 'optionId': 'once'}, {'kind': 'reject_once', 'optionId': 'reject'}]})
            continue
        elif value == 'stop':
            pending = message['id']
            continue
        elif value == 'paths':
            workspace = os.environ['GNOME_ASSISTANT_TEST_ROOT'] + '/workspace'
            text('Edited `preview.png:3` and ' + workspace + '/tone.wav:10:2, see ./project/src/ and `missing-file.txt`, '
                 + workspace + '/absent.txt or https://example.com/a/b.\n\n```python\nprint("hi")\n```\n\n```\n'
                 + workspace + '/run.sh\n```')
        elif value == 'diff-approval':
            pending = message['id']
            path = os.environ['GNOME_ASSISTANT_TEST_ROOT'] + '/workspace/notes.txt'
            old = ''.join(f'line {index}\n' for index in range(1, 61))
            new = ''.join(f'LINE {index}\n' if 20 <= index <= 30 else 'line five\n' if index == 5 else f'line {index}\n'
                          for index in range(1, 62) if index != 40)
            send(id='diff-approve', method='session/request_permission', params={'sessionId': 'a2ui-test',
                'toolCall': {'kind': 'edit', 'title': 'Edit notes.txt', 'locations': [{'path': path}],
                             'content': [{'type': 'diff', 'path': path, 'oldText': old, 'newText': new}]},
                'options': [{'kind': 'allow_once', 'optionId': 'once'}, {'kind': 'reject_once', 'optionId': 'reject'}]})
            continue
        else:
            assert value == '/native argument'
            text('Native command works.')
        send(id=message['id'], result={'stopReason': 'end_turn'})
    elif method == 'session/cancel':
        send(id=pending, result={'stopReason': 'cancelled'})
    elif message.get('id') == 'function-approve':
        assert message['result']['outcome']['optionId']=='once'
        result=mcp('render_a2ui',{'messages':function_pending[1]}); assert not result.get('isError'),result
        send(id=function_pending[0],result={'stopReason':'end_turn'})
    elif message.get('id') == 'diff-approve':
        assert message['result']['outcome']['optionId'] == 'once'
        text('Diff approved.')
        send(id=pending, result={'stopReason': 'end_turn'})
    elif message.get('id') == 'approve':
        assert message['result']['outcome']['optionId'] == 'once'
        text('Approved.')
        send(id=pending, result={'stopReason': 'end_turn'})
