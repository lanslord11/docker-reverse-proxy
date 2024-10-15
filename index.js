const http = require('http')
const express = require('express');
const Docker = require('dockerode');
const httpProxy = require('http-proxy');

const docker = new Docker({socketPath: '/var/run/docker.sock'});
const proxy = httpProxy.createProxy();

const db = new Map();


docker.getEvents(function(err,stream){
    if(err){
        console.log('Error getting docker events',err);
        return ;
    }

    stream.on('data',async(chunk)=>{
        if(!chunk)return;
        const event = JSON.parse(chunk.toString());

        if(event.Type === 'container' && event.Action === 'start'){
            const container = docker.getContainer(event.id);
            const containerInfo = await container.inspect();

            const containerName = containerInfo.Name.substring(1);
            const ipAddress = containerInfo.NetworkSettings.IPAddress;

            const exposedPort = Object.keys(containerInfo.Config.ExposedPorts);

            let defaultPort = null

            if(exposedPort && exposedPort.length > 0){
                const [port , type] = exposedPort[0].split('/')
                if(type ==='tcp'){
                    defaultPort = port;
                }
            }
            console.log(`Reegistering ${containerName}.localhost --> http://${ipAddress}:${defaultPort}`);
            db.set(containerName,{containerName , ipAddress,defaultPort});
        }

    });
})



const reverseProxyApp = express() ; 
reverseProxyApp.use(function(req,res){
    const hostname = req.hostname ; 
    const subdomain = hostname.split('.')[0];
    if (!db.has(subdomain)) return res.status(404).end(404);

    const {ipAddress,defaultPort} = db.get(subdomain);

    const target = `http://${ipAddress}:${defaultPort}`;

    console.log(`Forwarding ${hostname} -> ${proxy}`);

    return proxy.web(req,res,{target,changeOrigin:true});
})

const reverseProxy = http.createServer(reverseProxyApp);








const managementAPI = express();


managementAPI.use(express.json());

managementAPI.post('/containers', async (req, res) => {
    let imageAlreadyExists = false;
    const { image,tag = "latest"} = req.body;


    const images = await docker.listImages();

    for(const systemImages of images){
        for( const systemTag of systemImages.RepoTags){
            if(systemTag === `${image}:${tag}`){
                imageAlreadyExists = true;
                break;
            }
        }
        if(imageAlreadyExists){
            break;
        }

    }

    if(!imageAlreadyExists){
        // const stream = await docker.pull(`${image}:${tag}`);
        // await new Promise((resolve, reject) => {
        //     docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
        // });
        console.log('pulling image :', `${image}:${tag}`);
        await docker.pull(`${image}:${tag}`);
    }

    const container = docker.createContainer({
        Image: `${image}:${tag}`,
        Tty:false,
        HostConfig : { 
            AutoRemove : true,
        }
    });

    await container.start();

    return res.json({status:'success',container:`${(await container.inspect()).Name}.localhost`})
})


managementAPI.listen(8080,()=> console.log(`Management API is running on port 8080`));
reverseProxy.listen(80,()=> console.log(`Reverse Proxy is running on port 80`));